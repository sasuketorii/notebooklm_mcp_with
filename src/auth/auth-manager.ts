/**
 * Authentication Manager for NotebookLM
 *
 * Handles:
 * - Interactive login (headful browser for setup)
 * - Auto-login with credentials (email/password from ENV)
 * - Browser state persistence (cookies + localStorage + sessionStorage)
 * - Evidence-based snapshot and cookie validation
 * - Cross-process persistent-profile leasing
 *
 * Based on the Python implementation from auth.py
 */

import type { BrowserContext, ElementHandle, Page } from "patchright";
import { chmodSync, existsSync, lstatSync } from "fs";
import path from "path";
import {
  BaseProfileLease,
  inspectStorageState,
  inspectSnapshotFile,
  readSecureJson,
  writeSecureJson,
  type LeaseRecord,
  type SnapshotInspection,
} from "./auth-persistence.js";
import type { BaseProfileLeaseHandle } from "./auth-persistence.js";
import { CONFIG, NOTEBOOKLM_AUTH_URL } from "../config.js";
import {
  classifyNotebookLmAppUrl,
  isNotebookLmAuthDestination,
} from "../notebooklm/notebook-host.js";
import { log } from "../utils/logger.js";
import {
  getPreferredChannel,
  isChannelFailure,
  isProfileLockError,
  withChannel,
} from "../browser/chromium-fallback.js";
import {
  humanType,
  randomDelay,
  realisticClick,
  randomMouseMovement,
} from "../utils/stealth-utils.js";
import type { ProgressCallback } from "../types.js";

export class AuthManager {
  private stateFilePath: string;
  private sessionFilePath: string;
  private baseLease: BaseProfileLease;

  constructor() {
    this.stateFilePath = path.join(CONFIG.browserStateDir, "state.json");
    this.sessionFilePath = path.join(CONFIG.browserStateDir, "session.json");
    this.baseLease = new BaseProfileLease(CONFIG.browserStateDir);
    for (const sensitiveFile of [this.stateFilePath, this.sessionFilePath]) {
      try {
        const stat = lstatSync(sensitiveFile);
        if (stat.isFile() && !stat.isSymbolicLink()) chmodSync(sensitiveFile, 0o600);
      } catch {
        // Missing or unsafe entries are handled by the no-follow reader/writer.
      }
    }
  }

  // ============================================================================
  // Browser State Management
  // ============================================================================

  /**
   * Save entire browser state (cookies + localStorage)
   */
  async saveBrowserState(context: BrowserContext, page?: Page): Promise<boolean> {
    try {
      // Save storage state (cookies + localStorage + IndexedDB)
      const storageState = await context.storageState();
      await writeSecureJson(this.stateFilePath, storageState);

      // Also save sessionStorage if page is provided
      if (page) {
        try {
          const sessionStorageData: string = await page.evaluate((): string => {
            // Properly extract sessionStorage as a plain object
            const storage: Record<string, string> = {};
            for (let i = 0; i < sessionStorage.length; i++) {
              const key = sessionStorage.key(i);
              if (key) {
                storage[key] = sessionStorage.getItem(key) || "";
              }
            }
            return JSON.stringify(storage);
          });

          await writeSecureJson(this.sessionFilePath, JSON.parse(sessionStorageData));

          const entries = Object.keys(JSON.parse(sessionStorageData)).length;
          log.success(`✅ Browser state saved (incl. sessionStorage: ${entries} entries)`);
        } catch (error) {
          log.warning(`⚠️  State saved, but sessionStorage failed: ${error}`);
        }
      } else {
        log.success("✅ Browser state saved");
      }

      return true;
    } catch (error) {
      log.error(`❌ Failed to save browser state: ${error}`);
      return false;
    }
  }

  /**
   * Check if saved browser state exists
   */
  async hasSavedState(): Promise<boolean> {
    return (await this.inspectSnapshot()).bootstrapEligible;
  }

  /**
   * Get path to saved browser state
   */
  getStatePath(): string | null {
    // Synchronous check using imported existsSync
    if (existsSync(this.stateFilePath)) {
      return this.stateFilePath;
    }
    return null;
  }

  /**
   * Get valid state path (checks expiry)
   */
  async getValidStatePath(): Promise<string | null> {
    // mtime is not authentication evidence.  A snapshot is only a bootstrap
    // input for an isolated profile, never injected into the base profile.
    return (await this.inspectSnapshot()).bootstrapEligible ? this.stateFilePath : null;
  }

  async inspectSnapshot(): Promise<SnapshotInspection> {
    return inspectSnapshotFile(this.stateFilePath);
  }

  async acquireBaseProfileLease(mode: LeaseRecord["mode"]): Promise<BaseProfileLeaseHandle | null> {
    return this.baseLease.acquire(mode);
  }
  async ownsBaseProfileLease(
    handle: BaseProfileLeaseHandle,
    mode: LeaseRecord["mode"]
  ): Promise<boolean> {
    return this.baseLease.owns(handle, mode);
  }

  /**
   * Load sessionStorage from file
   */
  async loadSessionStorage(): Promise<Record<string, string> | null> {
    try {
      const sessionData = (await readSecureJson(this.sessionFilePath)) as Record<string, string>;
      log.success(`✅ Loaded sessionStorage (${Object.keys(sessionData).length} entries)`);
      return sessionData;
    } catch (error) {
      log.warning(`⚠️  Failed to load sessionStorage: ${error}`);
      return null;
    }
  }

  // ============================================================================
  // Cookie Validation
  // ============================================================================

  /**
   * Validate if saved state is still valid
   */
  async validateState(context: BrowserContext): Promise<boolean> {
    try {
      const cookies = await context.cookies();
      return inspectStorageState({ cookies, origins: [] }).bootstrapEligible;
    } catch (error) {
      log.warning(`⚠️  State validation failed: ${error}`);
      return false;
    }
  }

  /**
   * Validate if critical authentication cookies are still valid
   */
  async validateCookiesExpiry(context: BrowserContext): Promise<boolean> {
    try {
      const cookies = await context.cookies();
      const result = inspectStorageState({ cookies, origins: [] });
      if (!result.bootstrapEligible) log.warning(`⚠️  Cookie validation failed: ${result.reason}`);
      return result.bootstrapEligible;
    } catch (error) {
      log.warning(`⚠️  Cookie validation failed: ${error}`);
      return false;
    }
  }

  /** Return true when the snapshot lacks usable persistent-cookie evidence. */
  async isStateExpired(): Promise<boolean> {
    return !(await this.inspectSnapshot()).usable;
  }

  // ============================================================================
  // Interactive Login
  // ============================================================================

  /**
   * Perform interactive login
   * User will see a browser window and login manually
   *
   * Wait for a redirect to either official NotebookLM application host.
   */
  async performLogin(page: Page, sendProgress?: ProgressCallback): Promise<boolean> {
    try {
      log.info("🌐 Opening Google login page...");
      log.warning("📝 Please login to your Google account");
      log.warning("⏳ Browser will close automatically once you reach NotebookLM");
      log.info("");

      // Progress: Navigating
      await sendProgress?.("Navigating to Google login...", 3, 10);

      // Navigate to Google login (redirects to NotebookLM after auth)
      await page.goto(NOTEBOOKLM_AUTH_URL, { timeout: 60000 });

      // Progress: Waiting for login
      await sendProgress?.("Waiting for manual login (up to 10 minutes)...", 4, 10);

      // Wait for user to complete login
      log.warning("⏳ Waiting for login (up to 10 minutes)...");

      const checkIntervalMs = 1000; // Check every 1 second
      const maxAttempts = 600; // 10 minutes total
      let lastProgressUpdate = 0;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const currentUrl = page.url();
          const elapsedSeconds = Math.floor(attempt * (checkIntervalMs / 1000));

          // Send progress every 10 seconds
          if (elapsedSeconds - lastProgressUpdate >= 10) {
            lastProgressUpdate = elapsedSeconds;
            const progressStep = Math.min(8, 4 + Math.floor(elapsedSeconds / 60));
            await sendProgress?.(
              `Waiting for login... (${elapsedSeconds}s elapsed)`,
              progressStep,
              10
            );
          }

          if (await this.hasAuthenticatedNotebookDestination(page, currentUrl)) {
            await sendProgress?.("Login successful! NotebookLM detected!", 9, 10);
            log.success("✅ Login successful! NotebookLM URL detected.");
            log.success(`✅ Current URL: ${currentUrl}`);

            // Short wait to ensure page is loaded
            await page.waitForTimeout(2000);
            return true;
          }

          // Still on accounts.google.com - log periodically
          if (currentUrl.includes("accounts.google.com") && attempt % 30 === 0 && attempt > 0) {
            log.warning(`⏳ Still waiting... (${elapsedSeconds}s elapsed)`);
          }

          await page.waitForTimeout(checkIntervalMs);
        } catch {
          await page.waitForTimeout(checkIntervalMs);
          continue;
        }
      }

      // Timeout reached - final check
      const currentUrl = page.url();
      if (await this.hasAuthenticatedNotebookDestination(page, currentUrl)) {
        await sendProgress?.("Login successful (detected on timeout check)!", 9, 10);
        log.success("✅ Login successful (detected on timeout check)");
        return true;
      }

      log.error("❌ Login verification failed - timeout reached");
      log.warning(`Current URL: ${currentUrl}`);
      return false;
    } catch (error) {
      log.error(`❌ Login failed: ${error}`);
      return false;
    }
  }

  // ============================================================================
  // Auto-Login with Credentials
  // ============================================================================

  /**
   * Attempt to authenticate using configured credentials
   */
  async loginWithCredentials(page: Page, email: string, password: string): Promise<boolean> {
    const maskedEmail = this.maskEmail(email);
    log.warning(`🔁 Attempting automatic login for ${maskedEmail}...`);

    // Log browser visibility
    if (!CONFIG.headless) {
      log.info("  👁️  Browser is VISIBLE for debugging");
    } else {
      log.info("  🙈 Browser is HEADLESS (invisible)");
    }

    log.info(`  🌐 Navigating to Google login...`);

    try {
      await page.goto(NOTEBOOKLM_AUTH_URL, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.browserTimeout,
      });
      log.success(`  ✅ Page loaded: ${page.url().slice(0, 80)}...`);
    } catch {
      log.warning(`  ⚠️  Page load timeout (continuing anyway)`);
    }

    const deadline = Date.now() + CONFIG.autoLoginTimeoutMs;
    log.info(`  ⏰ Auto-login timeout: ${CONFIG.autoLoginTimeoutMs / 1000}s`);

    // Already on NotebookLM?
    log.info("  🔍 Checking if already authenticated...");
    if (await this.waitForNotebook(page, CONFIG.autoLoginTimeoutMs)) {
      log.success("✅ Already authenticated");
      return true;
    }

    log.warning("  ❌ Not authenticated yet, proceeding with login...");

    // Handle possible account chooser
    log.info("  🔍 Checking for account chooser...");
    if (await this.handleAccountChooser(page, email)) {
      log.success("  ✅ Account selected from chooser");
      if (await this.waitForNotebook(page, CONFIG.autoLoginTimeoutMs)) {
        log.success("✅ Automatic login successful");
        return true;
      }
    }

    // Email step
    log.info("  📧 Entering email address...");
    if (!(await this.fillIdentifier(page, email))) {
      if (await this.waitForNotebook(page, CONFIG.autoLoginTimeoutMs)) {
        log.success("✅ Automatic login successful");
        return true;
      }
      log.warning("⚠️  Email input not detected");
    }

    // Password step (wait until visible)
    let waitAttempts = 0;
    log.warning("  ⏳ Waiting for password page to load...");

    while (Date.now() < deadline && !(await this.fillPassword(page, password))) {
      waitAttempts++;

      // Log every 10 seconds (20 attempts * 0.5s)
      if (waitAttempts % 20 === 0) {
        const secondsWaited = waitAttempts * 0.5;
        const secondsRemaining = (deadline - Date.now()) / 1000;
        log.warning(
          `  ⏳ Still waiting for password field... (${secondsWaited}s elapsed, ${secondsRemaining.toFixed(0)}s remaining)`
        );
        log.info(`  📍 Current URL: ${page.url().slice(0, 100)}`);
      }

      if (page.url().includes("challenge")) {
        log.warning("⚠️  Additional verification required (Google challenge page).");
        return false;
      }
      await page.waitForTimeout(500);
    }

    // Wait for Google redirect after login
    log.info("  🔄 Waiting for Google redirect to NotebookLM...");

    if (await this.waitForRedirectAfterLogin(page, deadline)) {
      log.success("✅ Automatic login successful");
      return true;
    }

    // Login failed - diagnose
    log.error("❌ Automatic login timed out");

    // Take screenshot for debugging
    try {
      const screenshotPath = path.join(CONFIG.dataDir, `login_failed_${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
      log.info(`  📸 Screenshot saved: ${screenshotPath}`);
    } catch (error) {
      log.warning(`  ⚠️  Could not save screenshot: ${error}`);
    }

    // Diagnose specific failure reason
    const currentUrl = page.url();
    log.warning("  🔍 Diagnosing failure...");

    if (currentUrl.includes("accounts.google.com")) {
      if (currentUrl.includes("/signin/identifier")) {
        log.error("  ❌ Still on email page - email input might have failed");
        log.info("  💡 Check if email is correct in .env");
      } else if (currentUrl.includes("/challenge")) {
        log.error("  ❌ Google requires additional verification (2FA, CAPTCHA, suspicious login)");
        log.info("  💡 Try logging in manually first: use setup_auth tool");
      } else if (currentUrl.includes("/pwd") || currentUrl.includes("/password")) {
        log.error("  ❌ Still on password page - password input might have failed");
        log.info("  💡 Check if password is correct in .env");
      } else {
        log.error(`  ❌ Stuck on Google accounts page: ${currentUrl.slice(0, 80)}...`);
      }
    } else if (isNotebookLmAuthDestination(currentUrl)) {
      log.warning("  ⚠️  Reached a NotebookLM destination without valid live auth evidence");
      log.info("  💡 Wait for Google authentication to complete, then try again");
    } else if (classifyNotebookLmAppUrl(currentUrl)) {
      log.error(
        "  ❌ Reached an official NotebookLM page that is not an authenticated destination"
      );
    } else {
      log.error(`  ❌ Unexpected page: ${currentUrl.slice(0, 80)}...`);
    }

    return false;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Wait for Google to redirect to NotebookLM after successful login (SIMPLE & RELIABLE)
   *
   * Requires a narrow official destination and live critical-cookie evidence.
   */
  private async waitForRedirectAfterLogin(page: Page, deadline: number): Promise<boolean> {
    log.info("    ⏳ Waiting for redirect to NotebookLM...");

    while (Date.now() < deadline) {
      try {
        const currentUrl = page.url();

        if (await this.hasAuthenticatedNotebookDestination(page, currentUrl)) {
          log.success("    ✅ NotebookLM URL detected!");
          // Short wait to ensure page is loaded
          await page.waitForTimeout(2000);
          return true;
        }
      } catch {
        // Ignore errors
      }

      await page.waitForTimeout(500);
    }

    log.error("    ❌ Redirect timeout - NotebookLM URL not reached");
    return false;
  }

  /**
   * Wait for NotebookLM to load (SIMPLE & RELIABLE)
   *
   * Requires a narrow official destination and live critical-cookie evidence.
   */
  private async waitForNotebook(page: Page, timeoutMs: number): Promise<boolean> {
    const endTime = Date.now() + timeoutMs;

    while (Date.now() < endTime) {
      try {
        const currentUrl = page.url();

        if (await this.hasAuthenticatedNotebookDestination(page, currentUrl)) {
          log.success("  ✅ NotebookLM URL detected");
          return true;
        }
      } catch {
        // Ignore errors
      }

      await page.waitForTimeout(1000);
    }

    return false;
  }

  private async hasAuthenticatedNotebookDestination(
    page: Page,
    currentUrl: string
  ): Promise<boolean> {
    if (!isNotebookLmAuthDestination(currentUrl)) return false;
    try {
      const cookies = await page.context().cookies();
      return inspectStorageState({ cookies, origins: [] }).bootstrapEligible;
    } catch {
      return false;
    }
  }

  /**
   * Handle possible account chooser
   */
  private async handleAccountChooser(page: Page, email: string): Promise<boolean> {
    try {
      const chooser = await page.$$("div[data-identifier], li[data-identifier]");

      if (chooser.length > 0) {
        for (const item of chooser) {
          const identifier = (await item.getAttribute("data-identifier"))?.toLowerCase() || "";
          if (identifier === email.toLowerCase()) {
            await item.click();
            await randomDelay(150, 320);
            await page.waitForTimeout(500);
            return true;
          }
        }

        // Click "Use another account"
        await this.clickText(page, [
          "Use another account",
          "Weiteres Konto hinzufügen",
          "Anderes Konto verwenden",
        ]);
        await randomDelay(150, 320);
        return false;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Fill email identifier field with human-like typing
   */
  private async fillIdentifier(page: Page, email: string): Promise<boolean> {
    log.info("    📧 Looking for email field...");

    const emailSelectors = [
      "input#identifierId",
      "input[name='identifier']",
      "input[type='email']",
    ];

    let emailSelector: string | null = null;
    let emailField: ElementHandle<Element> | null = null;

    for (const selector of emailSelectors) {
      try {
        const candidate = await page.waitForSelector(selector, {
          state: "attached",
          timeout: 3000,
        });
        if (!candidate) continue;

        try {
          if (!(await candidate.isVisible())) {
            continue; // Hidden field
          }
        } catch {
          continue;
        }

        emailField = candidate;
        emailSelector = selector;
        log.success(`    ✅ Email field visible: ${selector}`);
        break;
      } catch {
        continue;
      }
    }

    if (!emailField || !emailSelector) {
      log.warning("    ℹ️  No visible email field found (likely pre-filled)");
      log.info(`    📍 Current URL: ${page.url().slice(0, 100)}`);
      return false;
    }

    // Human-like mouse movement to field
    try {
      const box = await emailField.boundingBox();
      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;
        await randomMouseMovement(page, targetX, targetY);
        await randomDelay(200, 500);
      }
    } catch {
      // Ignore errors
    }

    // Click to focus
    try {
      await realisticClick(page, emailSelector, false);
    } catch (error) {
      log.warning(`    ⚠️  Could not click email field (${error}); trying direct focus`);
      try {
        await emailField.focus();
      } catch {
        log.error("    ❌ Failed to focus email field");
        return false;
      }
    }

    // ✅ FASTER: Programmer typing speed (90-120 WPM from config)
    log.info(`    ⌨️  Typing email: ${this.maskEmail(email)}`);
    try {
      const wpm =
        CONFIG.typingWpmMin +
        Math.floor(Math.random() * (CONFIG.typingWpmMax - CONFIG.typingWpmMin + 1));
      await humanType(page, emailSelector, email, { wpm, withTypos: false });
      log.success("    ✅ Email typed successfully");
    } catch (error) {
      log.error(`    ❌ Typing failed: ${error}`);
      try {
        await page.fill(emailSelector, email);
        log.success("    ✅ Filled email using fallback");
      } catch {
        return false;
      }
    }

    // Human "thinking" pause before clicking Next
    await randomDelay(400, 1200);

    // Click Next button
    log.info("    🔘 Looking for Next button...");

    const nextSelectors = [
      "button:has-text('Next')",
      "button:has-text('Weiter')",
      "#identifierNext",
    ];

    let nextClicked = false;
    for (const selector of nextSelectors) {
      try {
        const button = await page.locator(selector);
        if ((await button.count()) > 0) {
          await realisticClick(page, selector, true);
          log.success(`    ✅ Next button clicked: ${selector}`);
          nextClicked = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!nextClicked) {
      log.warning("    ⚠️  Button not found, pressing Enter");
      await emailField.press("Enter");
    }

    // Variable delay
    await randomDelay(800, 1500);
    log.success("    ✅ Email step complete");
    return true;
  }

  /**
   * Fill password field with human-like typing
   */
  private async fillPassword(page: Page, password: string): Promise<boolean> {
    log.info("    🔐 Looking for password field...");

    const passwordSelectors = ["input[name='Passwd']", "input[type='password']"];

    let passwordSelector: string | null = null;
    let passwordField: ElementHandle<Element> | null = null;

    for (const selector of passwordSelectors) {
      try {
        passwordField = await page.$(selector);
        if (passwordField) {
          passwordSelector = selector;
          log.success(`    ✅ Password field found: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!passwordField) {
      // Not found yet, but don't fail - this is called in a loop
      return false;
    }

    // Human-like mouse movement to field
    try {
      const box = await passwordField.boundingBox();
      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;
        await randomMouseMovement(page, targetX, targetY);
        await randomDelay(300, 700);
      }
    } catch {
      // Ignore errors
    }

    // Click to focus
    if (passwordSelector) {
      await realisticClick(page, passwordSelector, false);
    }

    // ✅ FASTER: Programmer typing speed (90-120 WPM from config)
    log.info("    ⌨️  Typing password...");
    try {
      const wpm =
        CONFIG.typingWpmMin +
        Math.floor(Math.random() * (CONFIG.typingWpmMax - CONFIG.typingWpmMin + 1));
      if (passwordSelector) {
        await humanType(page, passwordSelector, password, { wpm, withTypos: false });
      }
      log.success("    ✅ Password typed successfully");
    } catch (error) {
      log.error(`    ❌ Typing failed: ${error}`);
      return false;
    }

    // Human "review" pause before submitting password
    await randomDelay(300, 1000);

    // Click Next button
    log.info("    🔘 Looking for Next button...");

    const pwdNextSelectors = [
      "button:has-text('Next')",
      "button:has-text('Weiter')",
      "#passwordNext",
    ];

    let pwdNextClicked = false;
    for (const selector of pwdNextSelectors) {
      try {
        const button = await page.locator(selector);
        if ((await button.count()) > 0) {
          await realisticClick(page, selector, true);
          log.success(`    ✅ Next button clicked: ${selector}`);
          pwdNextClicked = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!pwdNextClicked) {
      log.warning("    ⚠️  Button not found, pressing Enter");
      await passwordField.press("Enter");
    }

    // Variable delay
    await randomDelay(800, 1500);
    log.success("    ✅ Password step complete");
    return true;
  }

  /**
   * Click text element
   */
  private async clickText(page: Page, texts: string[]): Promise<boolean> {
    for (const text of texts) {
      const selector = `text="${text}"`;
      try {
        const locator = page.locator(selector);
        if ((await locator.count()) > 0) {
          await realisticClick(page, selector, true);
          await randomDelay(120, 260);
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  /**
   * Mask email for logging
   */
  private maskEmail(email: string): string {
    if (!email.includes("@")) {
      return "***";
    }
    const [name, domain] = email.split("@");
    if (name.length <= 2) {
      return `${"*".repeat(name.length)}@${domain}`;
    }
    return `${name[0]}${"*".repeat(name.length - 2)}${name[name.length - 1]}@${domain}`;
  }

  // ============================================================================
  // Additional Helper Methods
  // ============================================================================

  /**
   * Load authentication state from a specific file path
   */
  async loadAuthState(context: BrowserContext, statePath: string): Promise<boolean> {
    try {
      const state = (await readSecureJson(statePath)) as {
        cookies?: Parameters<BrowserContext["addCookies"]>[0];
      };

      // Add cookies to context
      if (state.cookies) {
        await context.addCookies(state.cookies);
        log.success(`✅ Loaded ${state.cookies.length} cookies from ${statePath}`);
        return true;
      }

      log.warning(`⚠️  No cookies found in state file`);
      return false;
    } catch (error) {
      log.error(`❌ Failed to load auth state: ${error}`);
      return false;
    }
  }

  /**
   * Perform interactive setup (for setup_auth tool)
   * Opens a PERSISTENT browser for manual login
   *
   * CRITICAL: Uses the SAME persistent context as runtime!
   * This ensures cookies are automatically saved to the Chrome profile.
   *
   * Benefits over temporary browser:
   * - Session cookies persist correctly (Playwright bug workaround)
   * - Same fingerprint as runtime
   * - No need for addCookies() workarounds
   * - Automatic cookie persistence via Chrome profile
   *
   * @param sendProgress Optional progress callback
   * @param overrideHeadless Optional override for headless mode (true = visible, false = headless)
   *                         If not provided, defaults to true (visible) for setup
   */
  async performSetup(
    sendProgress?: ProgressCallback,
    overrideHeadless?: boolean
  ): Promise<boolean> {
    const { chromium } = await import("patchright");
    let context: BrowserContext | undefined;

    // Determine headless mode: override or default to true (visible for setup)
    // overrideHeadless contains show_browser value (true = show, false = hide)
    const shouldShowBrowser = overrideHeadless !== undefined ? overrideHeadless : true;

    try {
      log.info("🚀 Launching persistent browser for interactive setup...");
      log.info(`  📍 Profile: ${CONFIG.chromeProfileDir}`);
      await sendProgress?.("Launching persistent browser...", 1, 10);

      // ✅ CRITICAL FIX: Use launchPersistentContext (same as runtime!)
      // This ensures session cookies persist correctly. Channel selection +
      // fallback shared with the runtime context manager (issues #13, #19).
      const baseLaunchOptions = {
        headless: !shouldShowBrowser,
        viewport: CONFIG.viewport,
        locale: "en-US",
        timezoneId: "Europe/Berlin",
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      };
      const preferred = getPreferredChannel();
      try {
        context = await chromium.launchPersistentContext(
          CONFIG.chromeProfileDir,
          withChannel(baseLaunchOptions, preferred)
        );
      } catch (err) {
        if (isProfileLockError(err)) {
          throw new Error("profile_busy", { cause: err });
        }
        if (preferred === "chrome" && isChannelFailure(err)) {
          log.warning("⚠️  System Chrome failed to launch — falling back to bundled Chromium.");
          context = await chromium.launchPersistentContext(
            CONFIG.chromeProfileDir,
            withChannel(baseLaunchOptions, "chromium")
          );
        } else {
          throw err;
        }
      }

      // Get or create a page
      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();

      // Perform login with progress updates
      const loginSuccess = await this.performLogin(page, sendProgress);

      if (loginSuccess) {
        // ✅ Save browser state to state.json (for validation & backup)
        // Chrome ALSO saves everything to the persistent profile automatically!
        await sendProgress?.("Saving authentication state...", 9, 10);
        if (!(await this.saveBrowserState(context, page))) return false;
        log.success("✅ Setup complete - authentication saved to:");
        log.success(`  📄 State file: ${this.stateFilePath}`);
        log.success(`  📁 Chrome profile: ${CONFIG.chromeProfileDir}`);
        log.info("💡 Session cookies will now persist across restarts!");
      }

      return loginSuccess;
    } catch (error) {
      if (
        isProfileLockError(error) ||
        (error instanceof Error && error.message.startsWith("profile_busy"))
      )
        throw new Error("profile_busy", { cause: error });
      log.error(`❌ Setup failed: ${error}`);
      return false;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================
}
