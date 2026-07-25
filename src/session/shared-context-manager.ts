/**
 * Shared Context Manager with Persistent Chrome Profile
 *
 * Manages ONE global persistent BrowserContext for ALL sessions.
 * This is critical for avoiding bot detection:
 *
 * - Google tracks browser fingerprints (Canvas, WebGL, Audio, Fonts, etc.)
 * - Multiple contexts = Multiple fingerprints = Suspicious!
 * - ONE persistent context = ONE consistent fingerprint = Normal user
 * - Persistent user_data_dir = SAME fingerprint across all app restarts!
 *
 * Based on the Python implementation from shared_context_manager.py
 */

import type { BrowserContext } from "patchright";
import { chromium } from "patchright";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import type { AuthManager } from "../auth/auth-manager.js";
import {
  getPreferredChannel,
  isProfileLockError,
  isChannelFailure,
  withChannel,
} from "../browser/chromium-fallback.js";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { BaseProfileLeaseHandle } from "../auth/auth-persistence.js";

export type ProfileModeDecision = "base" | "isolated" | "busy";

/** Pure policy used by runtime and deterministic strategy tests. */
export function decideProfileMode(
  strategy: "auto" | "single" | "isolated",
  baseLeaseAcquired: boolean,
  snapshotBootstrapEligible: boolean
): ProfileModeDecision {
  if (strategy === "isolated") return snapshotBootstrapEligible ? "isolated" : "busy";
  if (baseLeaseAcquired) return "base";
  if (strategy === "single") return "busy";
  return snapshotBootstrapEligible ? "isolated" : "busy";
}

export function shouldPublishRecoverySnapshot(
  isolated: boolean,
  runtimeVerified: boolean,
  ownsRuntimeLease: boolean
): boolean {
  return !isolated && runtimeVerified && ownsRuntimeLease;
}

/**
 * Shared Context Manager
 *
 * Benefits:
 * 1. ONE consistent browser fingerprint for all sessions
 * 2. Fingerprint persists across app restarts (user_data_dir)
 * 3. Mimics real user behavior (one browser, multiple tabs)
 * 4. Google sees: "Same browser since day 1"
 */
export class SharedContextManager {
  private authManager: AuthManager;
  private globalContext: BrowserContext | null = null;
  private contextCreatedAt: number | null = null;
  private currentProfileDir: string | null = null;
  private isIsolatedProfile: boolean = false;
  private currentHeadlessMode: boolean | null = null;
  private contextGenerationId: string | null = null;
  private runtimeVerifiedGeneration: string | null = null;
  private lastSnapshotPublishAt = 0;
  private snapshotPublishPromise?: Promise<void>;
  private baseLease?: BaseProfileLeaseHandle;
  private teardown:
    | {
        generation: string;
        promise: Promise<void>;
      }
    | undefined;

  constructor(authManager: AuthManager) {
    this.authManager = authManager;

    log.info("🌐 SharedContextManager initialized (PERSISTENT MODE)");
    log.info(`  Chrome Profile: ${CONFIG.chromeProfileDir}`);
    log.success("  Fingerprint: PERSISTENT across restarts! 🎯");

    // Cleanup old isolated profiles at startup (best-effort)
    if (CONFIG.cleanupInstancesOnStartup) {
      void this.pruneIsolatedProfiles("startup");
    }
  }

  /**
   * Get the global shared persistent context, or create new if needed
   *
   * Context is recreated only when:
   * - First time (no context exists in this app instance)
   * - Context was closed/invalid
   *
   * Note: Auth expiry does NOT recreate context - we reuse the SAME
   * fingerprint and just re-login!
   *
   * @param overrideHeadless Optional override for headless mode (true = show browser)
   */
  async getOrCreateContext(overrideHeadless?: boolean): Promise<BrowserContext> {
    await this.awaitTeardown();
    // Check if headless mode needs to be changed (e.g., show_browser=true)
    // If yes, close the browser so it gets recreated with the new mode
    if (this.needsHeadlessModeChange(overrideHeadless)) {
      log.warning("🔄 Headless mode change detected - recreating browser context...");
      await this.closeContext();
    }

    if (await this.needsRecreation()) {
      log.warning("🔄 Creating/Loading persistent context...");
      await this.recreateContext(overrideHeadless);
    } else {
      log.success("♻️  Reusing existing persistent context");
    }

    return this.globalContext!;
  }

  /**
   * Check if global context needs to be recreated
   */
  private async needsRecreation(): Promise<boolean> {
    // No context exists yet (first time or after manual close)
    if (!this.globalContext) {
      log.info("  ℹ️  No context exists yet");
      return true;
    }

    // Async validity check (will throw if closed)
    try {
      await this.globalContext.cookies();
      log.dim("  ✅ Context still valid (browser open)");
      return false;
    } catch {
      log.warning("  ⚠️  Context appears closed - will recreate");
      const generation = this.contextGenerationId;
      if (generation) await this.teardownGeneration(generation, true);
      return true;
    }
  }

  /**
   * Create/Load the global PERSISTENT context with Chrome user_data_dir
   *
   * This is THE KEY to fingerprint persistence!
   *
   * First time:
   * - Chrome creates new profile in user_data_dir
   * - Generates fingerprint (Canvas, WebGL, Audio, etc.)
   * - Saves everything to disk
   *
   * Subsequent starts:
   * - Chrome loads profile from user_data_dir
   * - SAME fingerprint as before! ✅
   * - Google sees: "Same browser since day 1"
   *
   * @param overrideHeadless Optional override for headless mode (true = show browser)
   */
  private async recreateContext(overrideHeadless?: boolean): Promise<void> {
    await this.closeContext();

    const initialLease =
      CONFIG.profileStrategy === "isolated"
        ? null
        : await this.authManager.acquireBaseProfileLease("runtime");
    // The base persistent profile is the sole live source of truth.  A
    // storage snapshot can only bootstrap a disposable isolated context.
    const statePath = await this.authManager.getValidStatePath();

    // Determine headless mode: use override if provided, otherwise use CONFIG
    const shouldBeHeadless = overrideHeadless !== undefined ? !overrideHeadless : CONFIG.headless;

    if (overrideHeadless !== undefined) {
      log.info(`  Browser visibility override: ${overrideHeadless ? "VISIBLE" : "HEADLESS"}`);
    }

    // Build launch options for persistent context
    // NOTE: userDataDir is passed as first parameter, NOT in options!
    const baseLaunchOptions = {
      headless: shouldBeHeadless,
      viewport: CONFIG.viewport,
      locale: "en-US",
      timezoneId: "Europe/Berlin",
      // The authoritative base profile is launched without storageState.
      // Only a fresh isolated profile receives the recovery snapshot below.
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    };

    // 🔥 CRITICAL: launchPersistentContext creates/loads Chrome profile
    // Strategy handling for concurrent instances + channel fallback
    // (issue #13 macOS Tahoe Chrome crash, issue #19 Windows exit code 21).
    // We start with the user-preferred channel (default `chrome`) and, on a
    // recognised channel-failure, retry with bundled `chromium`.
    const baseProfile = CONFIG.chromeProfileDir;
    const strategy = CONFIG.profileStrategy;
    const preferred = getPreferredChannel();
    const tryLaunch = async (userDataDir: string) => {
      log.info("  🚀 Launching persistent Chrome context...");
      log.dim(`  📍 Profile location: ${userDataDir}`);
      if (userDataDir !== baseProfile && statePath)
        log.info("  📄 Bootstrapping isolated profile from recovery snapshot");
      try {
        return await chromium.launchPersistentContext(
          userDataDir,
          withChannel(
            {
              ...baseLaunchOptions,
              ...(userDataDir !== baseProfile && statePath ? { storageState: statePath } : {}),
            },
            preferred
          )
        );
      } catch (err) {
        if (isProfileLockError(err)) throw err;
        if (preferred === "chrome" && isChannelFailure(err)) {
          log.warning(
            "⚠️  System Chrome failed to launch — falling back to bundled Chromium (set BROWSER_CHANNEL=chromium to skip this retry)."
          );
          return await chromium.launchPersistentContext(
            userDataDir,
            withChannel(
              {
                ...baseLaunchOptions,
                ...(userDataDir !== baseProfile && statePath ? { storageState: statePath } : {}),
              },
              "chromium"
            )
          );
        }
        throw err;
      }
    };

    try {
      const decision = decideProfileMode(strategy, !!initialLease, !!statePath);
      if (decision === "busy")
        throw new Error("profile_busy: isolated runtime requires a bootstrap-eligible snapshot");
      if (decision === "isolated") {
        const isolatedDir = await this.prepareIsolatedProfileDir();
        this.globalContext = await tryLaunch(isolatedDir);
        this.currentProfileDir = isolatedDir;
        this.isIsolatedProfile = true;
      } else {
        if (!initialLease) throw new Error("profile_busy");
        // We hold the base lease for the entire context lifetime.
        this.globalContext = await tryLaunch(baseProfile);
        this.baseLease = initialLease;
        const generationLease = initialLease;
        // The generation id is assigned below. The callback reads it only
        // after launch has completed and the heartbeat can run.
        initialLease.onLost(async () => {
          this.invalidateRuntimeVerification();
          const generation = this.contextGenerationId;
          if (this.baseLease === generationLease && generation)
            await this.teardownGeneration(generation, true);
        });
        this.currentProfileDir = baseProfile;
        this.isIsolatedProfile = false;
      }
    } catch (e) {
      const isSingleton = isProfileLockError(e);
      if (!isSingleton || strategy === "isolated") {
        await initialLease?.release();
        // hard fail
        throw e;
      }

      // auto strategy with lock → fall back to isolated instance dir
      log.warning(
        "⚠️  Base Chrome profile in use by another process. Falling back to isolated per-instance profile..."
      );
      await initialLease?.release();
      if (strategy === "single" || !statePath) throw new Error("profile_busy", { cause: e });
      const isolatedDir = await this.prepareIsolatedProfileDir();
      this.globalContext = await tryLaunch(isolatedDir);
      this.currentProfileDir = isolatedDir;
      this.isIsolatedProfile = true;
    }
    this.contextCreatedAt = Date.now();
    this.contextGenerationId = randomBytes(16).toString("hex");
    this.runtimeVerifiedGeneration = null;
    this.currentHeadlessMode = shouldBeHeadless;
    this.attachCloseListener(this.globalContext, this.contextGenerationId);

    log.success("✅ Persistent context ready!");
    log.dim(`  Context ID: ${this.getContextId()}`);
    log.dim(`  Chrome Profile: ${CONFIG.chromeProfileDir}`);
    log.success("  🎯 Fingerprint: PERSISTENT (same across restarts!)");
  }

  /**
   * Manually close the global context (e.g., on shutdown)
   *
   * Note: This closes the context for ALL sessions!
   * Chrome will save everything to user_data_dir automatically.
   */
  async closeContext(): Promise<void> {
    const generation = this.contextGenerationId;
    if (generation) {
      await this.teardownGeneration(generation, true);
      return;
    }
    await this.awaitTeardown();
  }

  /**
   * Every termination signal for one context generation converges here.
   * Clearing the public fields happens before the asynchronous close/release,
   * while getOrCreateContext waits for the retained promise before relaunching.
   */
  private teardownGeneration(generation: string, closeBrowser: boolean): Promise<void> {
    if (this.teardown?.generation === generation) return this.teardown.promise;
    if (this.contextGenerationId !== generation) return Promise.resolve();

    const context = this.globalContext;
    const lease = this.baseLease;
    const profileDir = this.currentProfileDir;
    const isolated = this.isIsolatedProfile;

    this.globalContext = null;
    this.contextCreatedAt = null;
    this.currentHeadlessMode = null;
    this.contextGenerationId = null;
    this.runtimeVerifiedGeneration = null;
    this.baseLease = undefined;
    this.currentProfileDir = null;
    this.isIsolatedProfile = false;

    // Start in a microtask so the retained record exists before context.close()
    // can synchronously emit "close" and re-enter this method.
    const promise = Promise.resolve()
      .then(async () => {
        if (closeBrowser && context) {
          log.warning("🛑 Closing persistent context...");
          try {
            await context.close();
            log.success("✅ Persistent context closed");
          } catch (error) {
            // Lease release remains mandatory even if Patchright close throws.
            log.warning(`⚠️  Browser close failed during teardown: ${error}`);
          }
        }
        await lease?.release();
        if (CONFIG.cleanupInstancesOnShutdown && isolated && profileDir) {
          await this.safeRemoveIsolatedProfile(profileDir).catch((error) => {
            log.warning(`  ⚠️  Cleanup (self) failed: ${error}`);
          });
        }
        if (CONFIG.cleanupInstancesOnShutdown) {
          await this.pruneIsolatedProfiles("shutdown").catch((error) => {
            log.warning(`  ⚠️  Cleanup (prune) failed: ${error}`);
          });
        }
      })
      .finally(() => {
        if (this.teardown?.generation === generation) this.teardown = undefined;
      });
    this.teardown = { generation, promise };
    return promise;
  }

  private async awaitTeardown(): Promise<void> {
    while (this.teardown) await this.teardown.promise;
  }

  private attachCloseListener(context: BrowserContext, generation: string): void {
    try {
      context.on("close", () => {
        log.warning("  🛑 Persistent context was closed externally");
        const teardown = this.teardownGeneration(generation, false);
        // Retain and observe the promise even though EventEmitter cannot await
        // listeners; callers entering afterwards await the same promise.
        teardown.catch((error) => log.warning(`  ⚠️  External close teardown failed: ${error}`));
      });
    } catch {
      /* close listener is optional — patchright versions differ */
    }
  }

  private async prepareIsolatedProfileDir(): Promise<string> {
    const stamp = `${process.pid}-${Date.now()}`;
    const dir = path.join(CONFIG.chromeInstancesDir, `instance-${stamp}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Never clone the base profile: it may be mutating and contains locks.
      // Auth recovery for an isolated process is limited to storageState above.
      log.info("  🧪 Using fresh isolated Chrome profile (no clone)");
    } catch (err) {
      log.warning(`  ⚠️  Could not prepare isolated profile: ${err}`);
    }
    return dir;
  }

  private async pruneIsolatedProfiles(phase: "startup" | "shutdown"): Promise<void> {
    const root = CONFIG.chromeInstancesDir;
    let entries: Array<{ path: string; mtimeMs: number }>;
    try {
      const names = await fs.promises.readdir(root, { withFileTypes: true });
      entries = [];
      for (const d of names) {
        if (!d.isDirectory()) continue;
        const p = path.join(root, d.name);
        try {
          const st = await fs.promises.stat(p);
          entries.push({ path: p, mtimeMs: st.mtimeMs });
        } catch {
          /* skip entries we can't stat (vanished or permission denied) */
        }
      }
    } catch {
      return; // directory absent is fine
    }

    if (entries.length === 0) return;

    const now = Date.now();
    const ttlMs = CONFIG.instanceProfileTtlHours * 3600 * 1000;
    const maxCount = Math.max(0, CONFIG.instanceProfileMaxCount);

    // Sort newest first
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const keep: Set<string> = new Set();
    const toDelete: Set<string> = new Set();

    // Keep newest up to maxCount
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const ageMs = now - e.mtimeMs;
      const overTtl = ttlMs > 0 && ageMs > ttlMs;
      const overCount = i >= maxCount;
      const isCurrent =
        this.currentProfileDir && path.resolve(e.path) === path.resolve(this.currentProfileDir);
      if (!isCurrent && (overTtl || overCount)) {
        toDelete.add(e.path);
      } else {
        keep.add(e.path);
      }
    }

    if (toDelete.size === 0) return;
    log.info(`🧹 Pruning isolated profiles (${phase})...`);
    for (const p of toDelete) {
      try {
        await this.safeRemoveIsolatedProfile(p);
        log.dim(`  🗑️  removed ${p}`);
      } catch (err) {
        log.warning(`  ⚠️  Failed to remove ${p}: ${err}`);
      }
    }
  }

  private async safeRemoveIsolatedProfile(dir: string): Promise<void> {
    // Never remove the base profile
    if (path.resolve(dir) === path.resolve(CONFIG.chromeProfileDir)) return;
    // Only remove within instances root
    if (!path.resolve(dir).startsWith(path.resolve(CONFIG.chromeInstancesDir))) return;
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // Older Node.js: rm may be unavailable; rmdir is the supported fallback.
      try {
        await fs.promises.rmdir(dir, { recursive: true });
      } catch {
        /* swallow — caller already logged the eviction context */
      }
    }
  }

  /**
   * Get information about the global persistent context
   */
  getContextInfo(): {
    exists: boolean;
    age_seconds?: number;
    age_hours?: number;
    fingerprint_id?: string;
    user_data_dir: string;
    persistent: boolean;
  } {
    if (!this.globalContext) {
      return {
        exists: false,
        user_data_dir: CONFIG.chromeProfileDir,
        persistent: true,
      };
    }

    const ageSeconds = this.contextCreatedAt
      ? (Date.now() - this.contextCreatedAt) / 1000
      : undefined;
    const ageHours = ageSeconds ? ageSeconds / 3600 : undefined;

    return {
      exists: true,
      age_seconds: ageSeconds,
      age_hours: ageHours,
      fingerprint_id: this.getContextId(),
      user_data_dir: CONFIG.chromeProfileDir,
      persistent: true,
    };
  }

  /**
   * Get the current headless mode of the browser context
   *
   * @returns boolean | null - true if headless, false if visible, null if no context exists
   */
  getCurrentHeadlessMode(): boolean | null {
    return this.currentHeadlessMode;
  }

  /** Called only after a live NotebookLM readiness check succeeds. */
  async markRuntimeVerified(): Promise<void> {
    if (
      !this.globalContext ||
      !this.contextGenerationId ||
      (!this.isIsolatedProfile &&
        (!this.baseLease ||
          !(await this.authManager.ownsBaseProfileLease(this.baseLease, "runtime"))))
    )
      return;
    this.runtimeVerifiedGeneration = this.contextGenerationId;
    if (this.isIsolatedProfile) return;
    if (this.snapshotPublishPromise) return this.snapshotPublishPromise;
    const generation = this.contextGenerationId;
    this.snapshotPublishPromise = (async () => {
      const lease = this.baseLease;
      const context = this.globalContext;
      if (!lease || !context || this.contextGenerationId !== generation) return;
      if (Date.now() - this.lastSnapshotPublishAt < 30_000) return;
      const ownsRuntimeLease = await this.authManager.ownsBaseProfileLease(lease, "runtime");
      if (
        this.contextGenerationId === generation &&
        shouldPublishRecoverySnapshot(
          this.isIsolatedProfile,
          this.isRuntimeVerified(),
          ownsRuntimeLease
        ) &&
        (await this.authManager.saveBrowserState(context))
      )
        this.lastSnapshotPublishAt = Date.now();
    })();
    try {
      await this.snapshotPublishPromise;
    } finally {
      this.snapshotPublishPromise = undefined;
    }
  }

  invalidateRuntimeVerification(): void {
    this.runtimeVerifiedGeneration = null;
  }

  isRuntimeVerified(): boolean {
    return (
      !!this.contextGenerationId && this.runtimeVerifiedGeneration === this.contextGenerationId
    );
  }

  /**
   * Check if the browser context needs to be recreated due to headless mode change
   *
   * @param overrideHeadless - Optional override for headless mode (true = show browser)
   * @returns boolean - true if context needs to be recreated with new mode
   */
  needsHeadlessModeChange(overrideHeadless?: boolean): boolean {
    // No context exists yet = will be created with correct mode anyway
    if (this.currentHeadlessMode === null) {
      return false;
    }

    // Calculate target headless mode
    // If override is specified, use it (!overrideHeadless because true = show browser = headless false)
    // Otherwise, use CONFIG.headless (which may have been temporarily modified by browser_options)
    const targetHeadless = overrideHeadless !== undefined ? !overrideHeadless : CONFIG.headless;

    // Compare with current mode
    const needsChange = this.currentHeadlessMode !== targetHeadless;

    if (needsChange) {
      log.info(
        `  Browser mode change detected: ${this.currentHeadlessMode ? "HEADLESS" : "VISIBLE"} → ${targetHeadless ? "HEADLESS" : "VISIBLE"}`
      );
    }

    return needsChange;
  }

  /**
   * Get context ID for logging
   */
  private getContextId(): string {
    if (!this.globalContext) return "none";
    // Patchright/Playwright contexts expose `_guid` internally for debugging;
    // it is not part of the public typings, so we read it through a narrowed
    // shape rather than `any`.
    const guid = (this.globalContext as unknown as { _guid?: string })._guid;
    return `ctx-${guid ?? "unknown"}`;
  }
}
