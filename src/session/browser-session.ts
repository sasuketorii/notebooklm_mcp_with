/**
 * Browser Session
 *
 * Represents a single browser session for NotebookLM interactions.
 *
 * Features:
 * - Human-like question typing
 * - Streaming response detection
 * - Auto-login on session expiry
 * - Session activity tracking
 * - Chat history reset
 *
 * Based on the Python implementation from browser_session.py
 */

import type { BrowserContext, Page } from "patchright";
import type { SharedContextManager } from "./shared-context-manager.js";
import type { AuthManager } from "../auth/auth-manager.js";
import { humanType, randomDelay } from "../utils/stealth-utils.js";
import { snapshotAllResponses } from "../utils/page-utils.js";
import { waitForStableAnswer, snapshotPriorAnswers } from "../notebooklm/chat.js";
import {
  extractCitations as extractCitationsFromPage,
  type SourceFormat,
  type ExtractCitationsResult,
} from "../notebooklm/citations.js";
import {
  addSource as addSourceToPage,
  type AddSourceInput,
  type AddSourceResult,
} from "../notebooklm/sources.js";
import {
  addAudioSource as addAudioSourceToPage,
  type AddAudioSourceInput,
  type AddAudioSourceResult,
} from "../notebooklm/audio-upload.js";
import {
  generateAudioOverview as generateAudioOnPage,
  downloadAudioOverview as downloadAudioOnPage,
  getAudioStatusOnPage,
  type GenerateAudioOptions,
  type AudioGenerationResult,
  type DownloadAudioResult,
} from "../notebooklm/audio.js";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import type { SessionInfo, ProgressCallback } from "../types.js";
import { RateLimitError } from "../errors.js";
import {
  addYouTubeSource as addYouTubeSourceOnPage,
  type AddYouTubeSourceInput,
  type AddYouTubeSourceResult,
} from "../notebooklm/youtube-source.js";
import {
  waitForSourceReady as waitForSourceReadyOnPage,
  type SourceReadinessResult,
} from "../notebooklm/source-readiness.js";
import {
  extractTranscriptFromSourceViewer,
  type TranscriptResult,
} from "../notebooklm/transcript-export.js";
import {
  formatQueryInputDiagnostics,
  recoverVisibleQueryInput,
} from "../notebooklm/query-input.js";
import { Selectors } from "../notebooklm/selectors.js";

export function shouldReuseInitializedPage(initialized: boolean, pageClosed: boolean): boolean {
  return initialized && !pageClosed;
}

export class BrowserSession {
  public readonly sessionId: string;
  public readonly notebookUrl: string;
  public readonly createdAt: number;
  public lastActivity: number;
  public messageCount: number;

  private context!: BrowserContext;
  private sharedContextManager: SharedContextManager;
  private authManager: AuthManager;
  private page: Page | null = null;
  private initialized: boolean = false;
  private operationTail: Promise<void> = Promise.resolve();
  private disposed: boolean = false;

  constructor(
    sessionId: string,
    sharedContextManager: SharedContextManager,
    authManager: AuthManager,
    notebookUrl: string
  ) {
    this.sessionId = sessionId;
    this.sharedContextManager = sharedContextManager;
    this.authManager = authManager;
    this.notebookUrl = notebookUrl;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.messageCount = 0;

    log.info(`🆕 BrowserSession ${sessionId} created`);
  }

  private async runExclusive<T>(operation: () => Promise<T>, allowDisposed = false): Promise<T> {
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.disposed && !allowDisposed) {
        throw new Error(`Session ${this.sessionId} has been closed and cannot be reopened`);
      }
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Initialize the session by creating a page and navigating to the notebook
   */
  private async initUnlocked(): Promise<void> {
    if (this.disposed) {
      throw new Error(`Session ${this.sessionId} has been closed and cannot be reopened`);
    }
    if (shouldReuseInitializedPage(this.initialized, this.isPageClosedSafe())) {
      log.warning(`⚠️  Session ${this.sessionId} already initialized`);
      return;
    }
    if (this.initialized) {
      await this.page?.close().catch(() => undefined);
      this.page = null;
      this.initialized = false;
    }

    log.info(`🚀 Initializing session ${this.sessionId}...`);

    try {
      // Ensure a valid shared context
      this.context = await this.sharedContextManager.getOrCreateContext();

      // Create new page (tab) in the shared context (with auto-recovery)
      try {
        this.page = await this.context.newPage();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          /has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)
        ) {
          log.warning("  ♻️  Context was closed. Recreating and retrying newPage...");
          this.context = await this.sharedContextManager.getOrCreateContext();
          this.page = await this.context.newPage();
        } else {
          throw e;
        }
      }
      log.success(`  ✅ Created new page`);

      // Navigate to notebook
      log.info("  🌐 Navigating to requested notebook...");
      await this.page.goto(this.notebookUrl, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.browserTimeout,
      });
      const expected = this.notebookUrl.match(/\/notebook\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
      const actual = this.page
        .url()
        .match(/\/notebook\/([0-9a-f-]{36})/i)?.[1]
        ?.toLowerCase();
      if (!expected || !actual || expected !== actual) {
        throw new Error("NotebookLM page URL does not match the requested notebook");
      }

      // Wait for page to stabilize
      await randomDelay(2000, 3000);

      // Check if we need to login
      const isAuthenticated = await this.authManager.validateCookiesExpiry(this.context);

      if (!isAuthenticated) {
        log.warning(`  🔑 Session ${this.sessionId} needs authentication`);
        const loginSuccess = await this.ensureAuthenticated();
        if (!loginSuccess) {
          throw new Error("Failed to authenticate session");
        }
      } else {
        log.success(`  ✅ Session already authenticated`);
      }

      // Wait for NotebookLM interface to load
      log.info(`  ⏳ Waiting for NotebookLM interface...`);
      await this.waitForNotebookLMReady();

      // This is the live authentication verdict.  Snapshot evidence alone is
      // never reported as live authentication.
      await this.sharedContextManager.markRuntimeVerified();

      this.initialized = true;
      this.updateActivity();
      log.success(`✅ Session ${this.sessionId} initialized successfully`);
    } catch (error) {
      this.sharedContextManager.invalidateRuntimeVerification();
      log.error(`❌ Failed to initialize session ${this.sessionId}: ${error}`);
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      throw error;
    }
  }

  async init(): Promise<void> {
    return this.runExclusive(() => this.initUnlocked());
  }

  /**
   * Wait for NotebookLM interface to be ready
   *
   * Uses the same centralized selector policy and bounded recovery sequence as
   * question submission. Visibility is the readiness criterion; disabled or
   * placeholder state remains NotebookLM's responsibility.
   */
  private async waitForNotebookLMReady(): Promise<void> {
    if (!this.page) {
      throw new Error("Page not initialized");
    }

    log.info("  ⏳ Waiting for NotebookLM query composer...");
    const result = await recoverVisibleQueryInput(this.page, {
      expectedNotebookUrl: this.notebookUrl,
      timeoutMs: CONFIG.browserTimeout,
    });
    if (!result.selector) {
      const diagnostics = formatQueryInputDiagnostics(result.diagnostics);
      log.error(`  ❌ NotebookLM query composer not ready; diagnostics=${diagnostics}`);
      throw new Error(`NotebookLM query composer was not visible; diagnostics=${diagnostics}`);
    }
    log.success("  ✅ NotebookLM query composer ready!");
  }

  private isPageClosedSafe(): boolean {
    if (!this.page) return true;
    try {
      if (this.page.isClosed()) return true;
      // Accessing URL should be safe; if page is gone, this may throw.
      void this.page.url();
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Ensure the session is authenticated, perform auto-login if needed
   */
  private async ensureAuthenticated(): Promise<boolean> {
    if (!this.page) {
      throw new Error("Page not initialized");
    }

    log.info(`🔑 Checking authentication for session ${this.sessionId}...`);

    // Check cookie validity
    const isValid = await this.authManager.validateCookiesExpiry(this.context);

    if (isValid) {
      log.success(`  ✅ Cookies valid`);
      return true;
    }

    log.warning(`  ⚠️  Cookies expired or invalid`);

    // Need fresh login
    this.sharedContextManager.invalidateRuntimeVerification();
    log.warning(`  🔑 Fresh login required`);

    if (CONFIG.autoLoginEnabled) {
      log.info(`  🤖 Attempting auto-login...`);
      const loginSuccess = await this.authManager.loginWithCredentials(
        this.page,
        CONFIG.loginEmail,
        CONFIG.loginPassword
      );

      if (loginSuccess) {
        log.success(`  ✅ Auto-login successful`);
        // Navigate back to notebook
        await this.page.goto(this.notebookUrl, {
          waitUntil: "domcontentloaded",
        });
        await randomDelay(2000, 3000);
        return true;
      } else {
        log.error(`  ❌ Auto-login failed`);
        return false;
      }
    } else {
      log.error(`  ❌ Auto-login disabled and no valid auth state - manual login required`);
      return false;
    }
  }

  /**
   * Ask a question to NotebookLM
   */
  private async askUnlocked(
    question: string,
    sendProgress?: ProgressCallback,
    _timeoutMs?: number
  ): Promise<string> {
    const askOnce = async (): Promise<string> => {
      await this.ensureBoundNotebookPageUnlocked();

      log.info(`💬 [${this.sessionId}] Asking: "${question.substring(0, 100)}..."`);
      const page = this.page!;
      // Ensure we're still authenticated
      await sendProgress?.("Verifying authentication...", 2, 5);
      const isAuth = await this.authManager.validateCookiesExpiry(this.context);
      if (!isAuth) {
        log.warning(`  🔑 Session expired, re-authenticating...`);
        await sendProgress?.("Re-authenticating session...", 2, 5);
        const reAuthSuccess = await this.ensureAuthenticated();
        if (!reAuthSuccess) {
          throw new Error("Failed to re-authenticate session");
        }
      }

      // Snapshot existing responses BEFORE asking — uses the v2 chat module
      // (issue #43). Falls back to the legacy snapshot only if the v2 helper
      // produced nothing, so we don't regress when the new selectors miss.
      log.info(`  📸 Snapshotting existing responses...`);
      let existingResponses = await snapshotPriorAnswers(page);
      if (existingResponses.length === 0) {
        existingResponses = await snapshotAllResponses(page);
      }
      log.success(`  ✅ Captured ${existingResponses.length} existing responses`);

      // Find the chat input
      const inputSelector = await this.findChatInput();
      if (!inputSelector) {
        throw new Error(
          "Could not find visible chat input element. " +
            "Please check if the notebook page has loaded correctly."
        );
      }

      log.info(`  ⌨️  Typing question with human-like behavior...`);
      await sendProgress?.("Typing question with human-like behavior...", 2, 5);
      await humanType(page, inputSelector, question, {
        withTypos: true,
        wpm: Math.max(CONFIG.typingWpmMin, CONFIG.typingWpmMax),
      });

      // Small pause before submitting
      await randomDelay(500, 1000);

      // Submit the question (Enter key)
      log.info(`  📤 Submitting question...`);
      await sendProgress?.("Submitting question...", 3, 5);
      await page.keyboard.press("Enter");

      // Small pause after submit
      await randomDelay(1000, 1500);

      // Wait for the response with streaming-stability detection (issue #43).
      // Timeout comes from CONFIG.answerTimeoutMs so users can tune it via
      // ANSWER_TIMEOUT_MS or browser_options.timeout_ms (issue #14, #27).
      log.info(`  ⏳ Waiting for response (streaming-stability)...`);
      await sendProgress?.("Waiting for NotebookLM response (streaming-stability)...", 3, 5);
      const answer = await waitForStableAnswer(page, {
        question,
        timeoutMs: _timeoutMs ?? CONFIG.answerTimeoutMs,
        pollIntervalMs: 750,
        ignoreTexts: existingResponses,
      });

      if (!answer) {
        throw new Error("Timeout waiting for response from NotebookLM");
      }

      // Check for rate limit errors AFTER receiving answer
      log.info(`  🔍 Checking for rate limit errors...`);
      if (await this.detectRateLimitError()) {
        throw new RateLimitError(
          "NotebookLM rate limit reached (50 queries/day for free accounts)"
        );
      }

      // Update session stats
      this.messageCount++;
      this.updateActivity();

      log.success(
        `✅ [${this.sessionId}] Received answer (${answer.length} chars, ${this.messageCount} total messages)`
      );

      return answer;
    };

    try {
      return await askOnce();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)) {
        log.warning(`  ♻️  Detected closed page/context. Recovering session and retrying ask...`);
        try {
          this.initialized = false;
          if (this.page) {
            try {
              await this.page.close();
            } catch {
              /* page already gone */
            }
          }
          this.page = null;
          await this.initUnlocked();
          return await askOnce();
        } catch (e2) {
          log.error(`❌ Recovery failed: ${e2}`);
          throw e2;
        }
      }
      log.error(`❌ [${this.sessionId}] Failed to ask question: ${msg}`);
      throw error;
    }
  }

  async ask(question: string, sendProgress?: ProgressCallback): Promise<string> {
    return this.runExclusive(() => this.askUnlocked(question, sendProgress));
  }

  /**
   * Ask and extract citations while holding the page lock for the whole pair.
   * Keeping these together is required because any intervening page operation
   * can replace the source panel that belongs to the answer.
   */
  async askWithCitations(
    question: string,
    format: SourceFormat,
    sendProgress?: ProgressCallback
  ): Promise<{ rawAnswer: string; citationResult: ExtractCitationsResult }> {
    return this.runExclusive(async () => {
      const rawAnswer = await this.askUnlocked(question, sendProgress);
      const citationResult = await this.extractCitationsUnlocked(rawAnswer, format);
      return { rawAnswer, citationResult };
    });
  }

  /**
   * Add a new source (URL or pasted text) to the active notebook page
   * (issue #25). Lazily initialises the session so the caller can use this
   * without first running `ask()`.
   */
  async addSource(input: AddSourceInput): Promise<AddSourceResult> {
    return this.runExclusive(async () => {
      await this.ensureMutationReadyUnlocked();
      return addSourceToPage(this.page!, input);
    });
  }

  /** Upload one or more local audio files using NotebookLM's source dialog. */
  async addAudioSource(input: AddAudioSourceInput): Promise<AddAudioSourceResult> {
    return this.runExclusive(async () => {
      await this.ensureMutationReadyUnlocked();
      return addAudioSourceToPage(this.page!, input);
    });
  }

  async addYouTubeSource(input: AddYouTubeSourceInput): Promise<AddYouTubeSourceResult> {
    return this.runExclusive(async () => {
      await this.ensureMutationReadyUnlocked();
      return addYouTubeSourceOnPage(this.page!, input);
    });
  }

  async waitForSourceReady(
    options: {
      sourceNames?: string[];
      timeoutMs?: number;
      pollIntervalMs?: number;
      stablePolls?: number;
    } = {}
  ): Promise<SourceReadinessResult> {
    return this.runExclusive(async () => {
      await this.ensureBoundNotebookPageUnlocked();
      return waitForSourceReadyOnPage(this.page!, options);
    });
  }

  async exportTranscript(
    sourceName: string,
    options: { maxChars?: number; timeoutMs?: number } = {},
    sendProgress?: ProgressCallback
  ): Promise<TranscriptResult> {
    return this.runExclusive(async () => {
      await this.ensureBoundNotebookPageUnlocked();
      await sendProgress?.("Opening exact source transcript viewer...", 0);
      try {
        return await extractTranscriptFromSourceViewer(this.page!, sourceName, options);
      } finally {
        // Transcript extraction may navigate to a source viewer; restore the
        // exact session-bound notebook before releasing the operation lock.
        await this.ensureBoundNotebookPageUnlocked();
      }
    });
  }

  /** Ensure source operations always run on this session's exact notebook. */
  private async ensureBoundNotebookPageUnlocked(): Promise<void> {
    if (!this.initialized || !this.page || this.isPageClosedSafe()) await this.initUnlocked();
    const expected = this.notebookUrl.match(/\/notebook\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
    const actual = this.page!.url()
      .match(/\/notebook\/([0-9a-f-]{36})/i)?.[1]
      ?.toLowerCase();
    if (!expected || actual !== expected) {
      await this.page!.goto(this.notebookUrl, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.browserTimeout,
      });
      const restored = this.page!.url()
        .match(/\/notebook\/([0-9a-f-]{36})/i)?.[1]
        ?.toLowerCase();
      if (restored !== expected) {
        throw new Error("NotebookLM page URL does not match the session-bound notebook");
      }
      await this.waitForNotebookLMReady();
    }
  }

  /**
   * Mutation invariant: current composer readiness is probed immediately
   * before any operation that can change notebook state or open an upload UI.
   * Session initialization is not treated as a durable readiness cache because
   * overlays and URL state can change while the notebook identity stays equal.
   */
  private async ensureMutationReadyUnlocked(): Promise<void> {
    await this.ensureBoundNotebookPageUnlocked();
    await this.waitForNotebookLMReady();
  }

  /**
   * Generate an Audio Overview for the active notebook (issue #11).
   */
  async generateAudio(options: GenerateAudioOptions = {}): Promise<AudioGenerationResult> {
    return this.runExclusive(async () => {
      await this.ensureMutationReadyUnlocked();
      return generateAudioOnPage(this.page!, options);
    });
  }

  /**
   * Non-blocking probe for the current Audio Overview state (issue #11).
   */
  async getAudioStatus(): Promise<AudioGenerationResult> {
    return this.runExclusive(async () => {
      await this.ensureBoundNotebookPageUnlocked();
      return getAudioStatusOnPage(this.page!);
    });
  }

  /**
   * Download the most recent Audio Overview (issue #11).
   */
  async downloadAudio(destinationDir: string): Promise<DownloadAudioResult> {
    return this.runExclusive(async () => {
      await this.ensureBoundNotebookPageUnlocked();
      return downloadAudioOnPage(this.page!, destinationDir);
    });
  }

  /**
   * Pull DOM-level citations from the most recent answer on this session's
   * page (issue #20). Must be called immediately after `ask()` — before any
   * follow-up question disturbs the source panel.
   */
  private async extractCitationsUnlocked(
    answer: string,
    format: SourceFormat
  ): Promise<ExtractCitationsResult> {
    if (format === "none" || !this.page || this.isPageClosedSafe()) {
      return { citations: [], formattedAnswer: answer };
    }
    try {
      return await extractCitationsFromPage(this.page, answer, format);
    } catch (err) {
      log.warning(`  ⚠️  Citation extraction failed: ${err}`);
      return { citations: [], formattedAnswer: answer };
    }
  }

  async extractCitations(answer: string, format: SourceFormat): Promise<ExtractCitationsResult> {
    return this.runExclusive(() => this.extractCitationsUnlocked(answer, format));
  }

  /**
   * Find the chat input element
   *
   * Uses the same centralized selector registry and bounded recovery policy as
   * initialization. No selector is duplicated here.
   */
  private async findChatInput(): Promise<string | null> {
    if (!this.page) {
      return null;
    }

    const result = await recoverVisibleQueryInput(this.page, {
      expectedNotebookUrl: this.notebookUrl,
      timeoutMs: CONFIG.browserTimeout,
    });
    if (result.selector) {
      log.success(`  ✅ Found chat input: ${result.selector}`);
      return result.selector;
    }
    log.error(
      `  ❌ Could not find visible chat input; diagnostics=${formatQueryInputDiagnostics(result.diagnostics)}`
    );
    return null;
  }

  /**
   * Detect if a rate limit error occurred
   *
   * Searches the page for error messages indicating rate limit/quota exhaustion.
   * Free NotebookLM accounts have 50 queries/day limit.
   *
   * @returns true if rate limit error detected, false otherwise
   */
  private async detectRateLimitError(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    // Error message selectors (common patterns for error containers)
    const errorSelectors = [
      ".error-message",
      ".error-container",
      "[role='alert']",
      ".rate-limit-message",
      "[data-error]",
      ".notification-error",
      ".alert-error",
      ".toast-error",
    ];

    // Keywords that indicate rate limiting
    const keywords = [
      "rate limit",
      "limit exceeded",
      "quota exhausted",
      "daily limit",
      "limit reached",
      "too many requests",
      "ratenlimit",
      "quota",
      "query limit",
      "request limit",
    ];

    // Check error containers for rate limit messages
    for (const selector of errorSelectors) {
      try {
        const elements = await this.page.$$(selector);
        for (const el of elements) {
          try {
            const text = await el.innerText();
            const lower = text.toLowerCase();

            if (keywords.some((k) => lower.includes(k))) {
              log.error(`🚫 Rate limit detected: ${text.slice(0, 100)}`);
              return true;
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    // Also check if chat input is disabled (sometimes NotebookLM disables input when rate limited)
    try {
      const inputSelector = Selectors.chat.queryInput[0];
      const input = await this.page.$(inputSelector);
      if (input) {
        const isDisabled = await input.evaluate((el) => {
          return (
            (el as HTMLTextAreaElement).disabled || (el as HTMLElement).hasAttribute("disabled")
          );
        });

        if (isDisabled) {
          // Check if there's an error message near the input
          const parent = await input.evaluateHandle((el) => el.parentElement);
          const parentEl = parent.asElement();
          if (parentEl) {
            try {
              const parentText = await parentEl.innerText();
              const lower = parentText.toLowerCase();
              if (keywords.some((k) => lower.includes(k))) {
                log.error(`🚫 Rate limit detected: Chat input disabled with error message`);
                return true;
              }
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Ignore errors checking input state
    }

    return false;
  }

  /**
   * Reset the chat history (start a new conversation)
   */
  private async resetUnlocked(): Promise<void> {
    const resetOnce = async (): Promise<void> => {
      if (!this.initialized || !this.page || this.isPageClosedSafe()) {
        await this.initUnlocked();
      }
      log.info(`🔄 [${this.sessionId}] Resetting chat history...`);
      // Reload the page to clear chat history
      await (this.page as Page).reload({ waitUntil: "domcontentloaded" });
      await randomDelay(2000, 3000);

      // Wait for interface to be ready again
      await this.waitForNotebookLMReady();

      // Reset message count
      this.messageCount = 0;
      this.updateActivity();

      log.success(`✅ [${this.sessionId}] Chat history reset`);
    };

    try {
      await resetOnce();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)) {
        log.warning(`  ♻️  Detected closed page/context during reset. Recovering and retrying...`);
        this.initialized = false;
        if (this.page) {
          try {
            await this.page.close();
          } catch {
            /* page already gone */
          }
        }
        this.page = null;
        await this.initUnlocked();
        await resetOnce();
        return;
      }
      log.error(`❌ [${this.sessionId}] Failed to reset: ${msg}`);
      throw error;
    }
  }

  async reset(): Promise<void> {
    return this.runExclusive(() => this.resetUnlocked());
  }

  /**
   * Close the session
   */
  private async closeUnlocked(): Promise<void> {
    log.info(`🛑 Closing session ${this.sessionId}...`);

    if (this.page) {
      try {
        await this.page.close();
        this.page = null;
        log.success(`  ✅ Page closed`);
      } catch (error) {
        log.warning(`  ⚠️  Error closing page: ${error}`);
      }
    }

    this.initialized = false;
    log.success(`✅ Session ${this.sessionId} closed`);
  }

  async close(): Promise<void> {
    this.disposed = true;
    return this.runExclusive(() => this.closeUnlocked(), true);
  }

  /**
   * Update last activity timestamp
   */
  updateActivity(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Check if session has expired (inactive for too long)
   */
  isExpired(timeoutSeconds: number): boolean {
    const inactiveSeconds = (Date.now() - this.lastActivity) / 1000;
    return inactiveSeconds > timeoutSeconds;
  }

  /**
   * Get session information
   */
  getInfo(): SessionInfo {
    const now = Date.now();
    return {
      id: this.sessionId,
      created_at: this.createdAt,
      last_activity: this.lastActivity,
      age_seconds: (now - this.createdAt) / 1000,
      inactive_seconds: (now - this.lastActivity) / 1000,
      message_count: this.messageCount,
      notebook_url: this.notebookUrl,
    };
  }

  /**
   * Check if session is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.page !== null;
  }
}
