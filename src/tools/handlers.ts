/**
 * MCP Tool Handlers
 *
 * Implements the logic for all MCP tools.
 */

import type { SessionManager } from "../session/session-manager.js";
import type { AuthManager } from "../auth/auth-manager.js";
import type { NotebookLibrary } from "../library/notebook-library.js";
import type {
  AddNotebookInput,
  LibraryStats,
  NotebookEntry,
  UpdateNotebookInput,
} from "../library/types.js";
import type { AddSourceResult } from "../notebooklm/sources.js";
import type { AddAudioSourceResult } from "../notebooklm/audio-upload.js";
import type { AudioGenerationResult, DownloadAudioResult } from "../notebooklm/audio.js";
import { CONFIG, applyBrowserOptions, type BrowserOptions } from "../config.js";
import { log } from "../utils/logger.js";
import type { AskQuestionResult, ToolResult, ProgressCallback } from "../types.js";
import { RateLimitError } from "../errors.js";
import { CleanupManager } from "../utils/cleanup-manager.js";
import { applyAiMarker, PROVENANCE } from "../utils/disclaimer.js";
import { assertNotebookLmUrl, getNotebookLmId } from "../notebooklm/notebook-url.js";
import { validateYouTubeUrl } from "../notebooklm/youtube-source.js";
import { writeTranscript } from "../notebooklm/transcript-export.js";
import type { AddYouTubeSourceResult } from "../notebooklm/youtube-source.js";
import type { SourceReadinessResult } from "../notebooklm/source-readiness.js";
import type { TranscriptResult, WriteReceipt } from "../notebooklm/transcript-export.js";
import type { BaseProfileLeaseHandle } from "../auth/auth-persistence.js";
import { classifyAuthHealth, type AuthStatus } from "../auth/auth-persistence.js";

// CONFIG is process-global and the HTTP transport deliberately shares one core
// across clients. Calls that need legacy per-call CONFIG overrides must therefore
// be serialized for the complete mutate -> await -> restore lifetime.
let browserConfigOperationTail: Promise<void> = Promise.resolve();

export async function withTemporaryBrowserConfig<T>(
  browserOptions: BrowserOptions | undefined,
  showBrowser: boolean | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const previous = browserConfigOperationTail;
  let release!: () => void;
  browserConfigOperationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  if (browserOptions === undefined && showBrowser === undefined) {
    try {
      return await operation();
    } finally {
      release();
    }
  }

  const originalConfig = { ...CONFIG };
  Object.assign(CONFIG, applyBrowserOptions(browserOptions, showBrowser));
  try {
    return await operation();
  } finally {
    Object.assign(CONFIG, originalConfig);
    release();
  }
}

/**
 * Follow-up reminder appended to ask_question answers when explicitly enabled.
 * Off by default in v2 (issue #28) — the imperative phrasing reads like
 * adversarial prompt injection to safety-trained host agents and creates
 * noisy false positives. Opt back in via `NOTEBOOKLM_FOLLOW_UP_REMINDER=true`.
 */
const FOLLOW_UP_REMINDER =
  "\n\nIs that all you need to know? You can always ask another question using the same session ID. Before you reply to the user, review their original request and this answer; if anything is still unclear or missing, ask another question first.";

function followUpReminderEnabled(): boolean {
  const raw = process.env.NOTEBOOKLM_FOLLOW_UP_REMINDER;
  if (raw === undefined) return false;
  const lower = raw.trim().toLowerCase();
  return lower === "true" || lower === "1" || lower === "yes";
}

/**
 * MCP Tool Handlers
 */
export class ToolHandlers {
  private sessionManager: SessionManager;
  private authManager: AuthManager;
  private library: NotebookLibrary;
  private createCleanupManager: () => CleanupManager;

  constructor(
    sessionManager: SessionManager,
    authManager: AuthManager,
    library: NotebookLibrary,
    options: { cleanupManagerFactory?: () => CleanupManager } = {}
  ) {
    this.sessionManager = sessionManager;
    this.authManager = authManager;
    this.library = library;
    this.createCleanupManager = options.cleanupManagerFactory ?? (() => new CleanupManager());
  }

  // Small deterministic test doubles from older callers predate the durable
  // lease API. Production AuthManager always implements these methods.
  private async acquireAuthLease(
    mode: "setup_auth" | "re_auth"
  ): Promise<BaseProfileLeaseHandle | { release: () => Promise<void> } | null> {
    const manager = this.authManager as AuthManager & {
      acquireBaseProfileLease?: (
        m: "setup_auth" | "re_auth"
      ) => Promise<BaseProfileLeaseHandle | null>;
    };
    return manager.acquireBaseProfileLease
      ? manager.acquireBaseProfileLease(mode)
      : { release: async () => undefined };
  }
  private async releaseAuthLease(lease: { release: () => Promise<void> }): Promise<void> {
    await lease.release();
  }
  /**
   * Handle ask_question tool
   */
  async handleAskQuestion(
    args: {
      question: string;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
      browser_options?: BrowserOptions;
      source_format?: "none" | "inline" | "footnotes" | "json";
    },
    sendProgress?: ProgressCallback
  ): Promise<ToolResult<AskQuestionResult>> {
    const {
      question,
      session_id,
      notebook_id,
      notebook_url,
      show_browser,
      browser_options,
      source_format = "none",
    } = args;

    log.info(`🔧 [TOOL] ask_question called`);
    log.info(`  Question: "${question.substring(0, 100)}"...`);
    if (session_id) {
      log.info(`  Session ID: ${session_id}`);
    }
    if (notebook_id) {
      log.info(`  Notebook ID: ${notebook_id}`);
    }
    if (notebook_url) {
      log.info(`  Notebook URL: ${notebook_url}`);
    }

    try {
      // Resolve notebook URL
      let resolvedNotebookUrl = notebook_url;

      if (!resolvedNotebookUrl && notebook_id) {
        const notebook = this.library.incrementUseCount(notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${notebook_id}`);
        }

        resolvedNotebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!resolvedNotebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          const notebook = this.library.incrementUseCount(active.id);
          if (!notebook) {
            throw new Error(`Active notebook not found: ${active.id}`);
          }
          resolvedNotebookUrl = notebook.url;
          log.info(`  Using active notebook: ${notebook.name}`);
        }
      }

      // Progress: Getting or creating session
      await sendProgress?.("Getting or creating browser session...", 1, 5);

      // Calculate overrideHeadless parameter for session manager
      // show_browser takes precedence over browser_options.headless
      let overrideHeadless: boolean | undefined = undefined;
      if (show_browser !== undefined) {
        overrideHeadless = show_browser;
      } else if (browser_options?.show !== undefined) {
        overrideHeadless = browser_options.show;
      } else if (browser_options?.headless !== undefined) {
        overrideHeadless = !browser_options.headless;
      }

      return await withTemporaryBrowserConfig(browser_options, show_browser, async () => {
        // Get or create session (with headless override to handle mode changes)
        const session = await this.sessionManager.getOrCreateSession(
          session_id,
          resolvedNotebookUrl,
          overrideHeadless
        );

        // Progress: Asking question
        await sendProgress?.("Asking question to NotebookLM...", 2, 5);

        // Ask the question (pass progress callback)
        // Ask and citation extraction are one BrowserSession operation. No
        // other tool may touch the page between the answer and its sources.
        const { citationResult } = await session.askWithCitations(
          question,
          source_format,
          sendProgress
        );
        const baseAnswer = citationResult.formattedAnswer;

        const trimmed = baseAnswer.trimEnd();
        const withReminder = followUpReminderEnabled()
          ? `${trimmed}${FOLLOW_UP_REMINDER}`
          : trimmed;
        const answer = applyAiMarker(withReminder);

        // Get session info
        const sessionInfo = session.getInfo();

        const result: AskQuestionResult = {
          status: "success",
          question,
          answer,
          session_id: session.sessionId,
          notebook_url: session.notebookUrl,
          session_info: {
            age_seconds: sessionInfo.age_seconds,
            message_count: sessionInfo.message_count,
            last_activity: sessionInfo.last_activity,
          },
          _provenance: PROVENANCE,
          source_format,
          ...(citationResult.citations.length > 0 && { sources: citationResult.citations }),
        };

        // Progress: Complete
        await sendProgress?.("Question answered successfully!", 5, 5);

        log.success(`✅ [TOOL] ask_question completed successfully`);
        return {
          success: true,
          data: result,
        };
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Special handling for rate limit errors
      if (error instanceof RateLimitError || errorMessage.toLowerCase().includes("rate limit")) {
        log.error(`🚫 [TOOL] Rate limit detected`);
        return {
          success: false,
          error:
            "NotebookLM rate limit reached (50 queries/day for free accounts).\n\n" +
            "You can:\n" +
            "1. Wait until tomorrow for the quota to reset\n" +
            "2. Upgrade to Google AI Pro/Ultra for 5x higher limits\n\n" +
            `Original error: ${errorMessage}`,
        };
      }

      log.error(`❌ [TOOL] ask_question failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_sessions tool
   */
  async handleListSessions(): Promise<
    ToolResult<{
      active_sessions: number;
      max_sessions: number;
      session_timeout: number;
      oldest_session_seconds: number;
      total_messages: number;
      sessions: Array<{
        id: string;
        created_at: number;
        last_activity: number;
        age_seconds: number;
        inactive_seconds: number;
        message_count: number;
        notebook_url: string;
      }>;
    }>
  > {
    log.info(`🔧 [TOOL] list_sessions called`);

    try {
      const stats = this.sessionManager.getStats();
      const sessions = this.sessionManager.getAllSessionsInfo();

      const result = {
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        oldest_session_seconds: stats.oldest_session_seconds,
        total_messages: stats.total_messages,
        sessions: sessions.map((info) => ({
          id: info.id,
          created_at: info.created_at,
          last_activity: info.last_activity,
          age_seconds: info.age_seconds,
          inactive_seconds: info.inactive_seconds,
          message_count: info.message_count,
          notebook_url: info.notebook_url,
        })),
      };

      log.success(`✅ [TOOL] list_sessions completed (${result.active_sessions} sessions)`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_sessions failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle close_session tool
   */
  async handleCloseSession(args: {
    session_id: string;
  }): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
    const { session_id } = args;

    log.info(`🔧 [TOOL] close_session called`);
    log.info(`  Session ID: ${session_id}`);

    try {
      const closed = await this.sessionManager.closeSession(session_id);

      if (closed) {
        log.success(`✅ [TOOL] close_session completed`);
        return {
          success: true,
          data: {
            status: "success",
            message: `Session ${session_id} closed successfully`,
            session_id,
          },
        };
      } else {
        log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
        return {
          success: false,
          error: `Session ${session_id} not found`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] close_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle reset_session tool
   */
  async handleResetSession(args: {
    session_id: string;
  }): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
    const { session_id } = args;

    log.info(`🔧 [TOOL] reset_session called`);
    log.info(`  Session ID: ${session_id}`);

    return withTemporaryBrowserConfig(undefined, undefined, async () => {
      try {
        const session = this.sessionManager.getSession(session_id);

        if (!session) {
          log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
          return {
            success: false,
            error: `Session ${session_id} not found`,
          };
        }

        await session.reset();

        log.success(`✅ [TOOL] reset_session completed`);
        return {
          success: true,
          data: {
            status: "success",
            message: `Session ${session_id} reset successfully`,
            session_id,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] reset_session failed: ${errorMessage}`);
        return {
          success: false,
          error: errorMessage,
        };
      }
    });
  }

  /**
   * Handle get_health tool
   */
  async handleGetHealth(): Promise<
    ToolResult<{
      status: string;
      authenticated: boolean;
      auth_status: AuthStatus;
      auth_evidence: string;
      notebook_url: string;
      active_notebook_id: string | null;
      active_notebook_name: string | null;
      total_notebooks: number;
      active_sessions: number;
      max_sessions: number;
      session_timeout: number;
      total_messages: number;
      headless: boolean;
      auto_login_enabled: boolean;
      stealth_enabled: boolean;
      troubleshooting_tip?: string;
    }>
  > {
    log.info(`🔧 [TOOL] get_health called`);

    try {
      // Health is deliberately offline: it must not launch a browser, take a
      // profile lease, navigate, or touch a Chrome profile database.
      const snapshot = await this.authManager.inspectSnapshot();
      const runtimeVerified = this.sessionManager.isRuntimeVerified();
      const { authenticated, auth_status, auth_evidence } = classifyAuthHealth(
        snapshot,
        runtimeVerified
      );

      // Get session stats
      const stats = this.sessionManager.getStats();

      // Resolve current notebook from the library — `CONFIG.notebookUrl` is a
      // legacy field (v1) that's no longer set in v2's library-driven flow.
      const active = this.library.getActiveNotebook();
      const notebookUrl = active?.url || CONFIG.notebookUrl || "not configured";

      const result = {
        status: "ok",
        authenticated,
        auth_status,
        auth_evidence,
        notebook_url: notebookUrl,
        active_notebook_id: active?.id ?? null,
        active_notebook_name: active?.name ?? null,
        total_notebooks: this.library.getStats().total_notebooks,
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        total_messages: stats.total_messages,
        headless: CONFIG.headless,
        auto_login_enabled: CONFIG.autoLoginEnabled,
        stealth_enabled: CONFIG.stealthEnabled,
        // Add troubleshooting tip if not authenticated
        ...(!authenticated && {
          troubleshooting_tip:
            "Existing authentication was not modified. Use setup_auth only when you explicitly need a new login; cleanup_data is preview-only.",
        }),
      };

      log.success(`✅ [TOOL] get_health completed`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_health failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle setup_auth tool
   *
   * Opens a browser window for manual login with live progress updates.
   * The operation waits synchronously for login completion (up to 10 minutes).
   */
  async handleSetupAuth(
    args: {
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    sendProgress?: ProgressCallback
  ): Promise<
    ToolResult<{
      status: string;
      message: string;
      authenticated: boolean;
      duration_seconds?: number;
    }>
  > {
    const { show_browser, browser_options } = args;

    // CRITICAL: Send immediate progress to reset timeout from the very start
    await sendProgress?.("Initializing authentication setup...", 0, 10);

    log.info(`🔧 [TOOL] setup_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

    try {
      return await withTemporaryBrowserConfig(browser_options, show_browser, async () => {
        const lease = await this.acquireAuthLease("setup_auth");
        if (!lease) return { success: false, error: "profile_busy" };
        try {
          // Progress: Starting
          await sendProgress?.("Preparing authentication browser...", 1, 10);

          log.info(`  🌐 Opening browser for interactive login...`);

          // Progress: Opening browser
          await sendProgress?.("Opening browser window...", 2, 10);

          // Perform setup with progress updates (uses CONFIG internally)
          const success = await this.authManager.performSetup(sendProgress, show_browser);

          const durationSeconds = (Date.now() - startTime) / 1000;

          if (success) {
            // Progress: Complete
            await sendProgress?.("Authentication saved successfully!", 10, 10);

            log.success(`✅ [TOOL] setup_auth completed (${durationSeconds.toFixed(1)}s)`);
            return {
              success: true,
              data: {
                status: "authenticated",
                message: "Successfully authenticated and saved browser state",
                authenticated: true,
                duration_seconds: durationSeconds,
              },
            };
          } else {
            log.error(`❌ [TOOL] setup_auth failed (${durationSeconds.toFixed(1)}s)`);
            return {
              success: false,
              error: "Authentication failed or was cancelled",
            };
          }
        } finally {
          await this.releaseAuthLease(lease);
        }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationSeconds = (Date.now() - startTime) / 1000;
      log.error(`❌ [TOOL] setup_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Compatibility endpoint. It is deliberately unavailable and has no side
   * effects until staged profile switching can preserve the current account.
   */
  async handleReAuth(
    _args: {
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    _sendProgress?: ProgressCallback
  ): Promise<ToolResult<never>> {
    return {
      success: false,
      error:
        "re_auth_unavailable: account rotation and authentication wiping are unsupported; existing authentication was not touched",
    };
  }

  /**
   * Handle add_notebook tool
   */
  async handleAddNotebook(
    args: AddNotebookInput
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] add_notebook called`);
    log.info(`  Name: ${args.name}`);

    try {
      const notebook = this.library.addNotebook(args);
      log.success(`✅ [TOOL] add_notebook completed: ${notebook.id}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] add_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_notebooks tool
   */
  async handleListNotebooks(): Promise<ToolResult<{ notebooks: NotebookEntry[] }>> {
    log.info(`🔧 [TOOL] list_notebooks called`);

    try {
      const notebooks = this.library.listNotebooks();
      log.success(`✅ [TOOL] list_notebooks completed (${notebooks.length} notebooks)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_notebook tool
   */
  async handleGetNotebook(args: { id: string }): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] get_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      log.success(`✅ [TOOL] get_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle select_notebook tool
   */
  async handleSelectNotebook(args: {
    id: string;
  }): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] select_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.selectNotebook(args.id);
      log.success(`✅ [TOOL] select_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] select_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle update_notebook tool
   */
  async handleUpdateNotebook(
    args: UpdateNotebookInput
  ): Promise<ToolResult<{ notebook: NotebookEntry }>> {
    log.info(`🔧 [TOOL] update_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.updateNotebook(args);
      log.success(`✅ [TOOL] update_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] update_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle remove_notebook tool
   */
  async handleRemoveNotebook(args: {
    id: string;
  }): Promise<ToolResult<{ removed: boolean; closed_sessions: number }>> {
    log.info(`🔧 [TOOL] remove_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      const removed = this.library.removeNotebook(args.id);
      if (removed) {
        const closedSessions = await this.sessionManager.closeSessionsForNotebook(notebook.url);
        log.success(`✅ [TOOL] remove_notebook completed`);
        return {
          success: true,
          data: { removed: true, closed_sessions: closedSessions },
        };
      } else {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] remove_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle search_notebooks tool
   */
  async handleSearchNotebooks(args: {
    query: string;
  }): Promise<ToolResult<{ notebooks: NotebookEntry[] }>> {
    log.info(`🔧 [TOOL] search_notebooks called`);
    log.info(`  Query: "${args.query}"`);

    try {
      const notebooks = this.library.searchNotebooks(args.query);
      log.success(`✅ [TOOL] search_notebooks completed (${notebooks.length} results)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] search_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_library_stats tool
   */
  async handleGetLibraryStats(): Promise<ToolResult<LibraryStats>> {
    log.info(`🔧 [TOOL] get_library_stats called`);

    try {
      const stats = this.library.getStats();
      log.success(`✅ [TOOL] get_library_stats completed`);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_library_stats failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Return a read-only cleanup preview. Deletion is deliberately unavailable.
   */
  async handleCleanupData(args: { confirm: boolean; preserve_library?: boolean }): Promise<
    ToolResult<{
      status: string;
      mode: string;
      preview?: {
        categories: Array<{
          name: string;
          description: string;
          paths: string[];
          totalBytes: number;
          optional: boolean;
        }>;
        totalPaths: number;
        totalSizeBytes: number;
      };
    }>
  > {
    if (args.confirm) return { success: false, error: "cleanup_unavailable: preview-only" };
    const { confirm, preserve_library = false } = args;

    log.info(`🔧 [TOOL] cleanup_data called`);
    log.info(`  Confirm: ${confirm}`);
    log.info(`  Preserve Library: ${preserve_library}`);

    const cleanupManager = this.createCleanupManager();

    try {
      // Always run in deep mode
      const mode = "deep";

      {
        // Preview mode - show what would be deleted
        log.info(`  📋 Generating cleanup preview (mode: ${mode})...`);

        const preview = await cleanupManager.getCleanupPaths(mode, preserve_library);
        const platformInfo = cleanupManager.getPlatformInfo();

        log.info(
          `  Found ${preview.totalPaths.length} items (${cleanupManager.formatBytes(preview.totalSizeBytes)})`
        );
        log.info(`  Platform: ${platformInfo.platform}`);

        return {
          success: true,
          data: {
            status: "preview",
            mode,
            preview: {
              categories: preview.categories,
              totalPaths: preview.totalPaths.length,
              totalSizeBytes: preview.totalSizeBytes,
            },
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] cleanup_data failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Resolve a notebook URL the same way `handleAskQuestion` does. Used by the
   * new source/audio tools so we don't duplicate the lookup logic.
   */
  private async resolveNotebookUrl(
    notebookId?: string,
    notebookUrl?: string,
    sessionId?: string
  ): Promise<string | undefined> {
    const existing = sessionId ? this.sessionManager.getSession(sessionId) : undefined;
    if (existing) {
      const bound = assertNotebookLmUrl(existing.notebookUrl);
      const boundId = getNotebookLmId(bound);
      if (notebookUrl && getNotebookLmId(notebookUrl) !== boundId)
        throw new Error("session_id is bound to a different notebook_url");
      if (notebookId) {
        const nb = this.library.getNotebook(notebookId);
        if (!nb) throw new Error(`Notebook not found in library: ${notebookId}`);
        if (getNotebookLmId(nb.url) !== boundId)
          throw new Error("session_id is bound to a different notebook_id");
      }
      return bound;
    }
    if (notebookUrl) {
      const direct = assertNotebookLmUrl(notebookUrl);
      if (notebookId) {
        const nb = this.library.getNotebook(notebookId);
        if (!nb) throw new Error(`Notebook not found in library: ${notebookId}`);
        if (getNotebookLmId(nb.url) !== getNotebookLmId(direct))
          throw new Error("notebook_id and notebook_url target different notebooks");
      }
      return direct;
    }
    if (notebookId) {
      const nb = this.library.getNotebook(notebookId);
      if (!nb) throw new Error(`Notebook not found in library: ${notebookId}`);
      return assertNotebookLmUrl(nb.url);
    }
    const active = this.library.getActiveNotebook();
    return active ? assertNotebookLmUrl(active.url) : undefined;
  }

  /**
   * Handle add_source tool (issue #25).
   */
  async handleAddSource(args: {
    type: "url" | "text";
    content: string;
    title?: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AddSourceResult }>> {
    log.info(`🔧 [TOOL] add_source called (type=${args.type})`);
    return withTemporaryBrowserConfig(undefined, args.show_browser, async () => {
      const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
      try {
        const url = await this.resolveNotebookUrl(
          args.notebook_id,
          args.notebook_url,
          args.session_id
        );
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.addSource({
          type: args.type,
          content: args.content,
          title: args.title,
        });
        return { success: result.success, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] add_source failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /** Handle local audio source upload through NotebookLM's file chooser. */
  async handleAddAudioSource(args: {
    file_paths: string[];
    timeout_ms?: number;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AddAudioSourceResult }>> {
    log.info(`🔧 [TOOL] add_audio_source called (files=${args.file_paths?.length ?? 0})`);
    // Do not mutate global CONFIG: all sessions share a browser context.
    return withTemporaryBrowserConfig(undefined, args.show_browser, async () => {
      const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
      try {
        const url = await this.resolveNotebookUrl(
          args.notebook_id,
          args.notebook_url,
          args.session_id
        );
        if (!url) {
          throw new Error(
            "No target notebook selected. Provide notebook_id or notebook_url, or run select_notebook first."
          );
        }
        assertNotebookLmUrl(url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.addAudioSource({
          filePaths: args.file_paths,
          timeoutMs: args.timeout_ms,
        });
        return { success: result.success, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] add_audio_source failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  async handleAddYouTubeSource(args: {
    url: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
    timeout_ms?: number;
  }): Promise<ToolResult<{ result: AddYouTubeSourceResult }>> {
    return withTemporaryBrowserConfig(undefined, args.show_browser, async () => {
      try {
        const url = await this.resolveNotebookUrl(
          args.notebook_id,
          args.notebook_url,
          args.session_id
        );
        if (!url) throw new Error("No target notebook selected");
        assertNotebookLmUrl(url);
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          args.show_browser
        );
        const result = await session.addYouTubeSource({
          url: validateYouTubeUrl(args.url),
          timeoutMs: args.timeout_ms,
        });
        return { success: result.success, data: { result } };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  async handleWaitForSourceReady(args: {
    source_names?: string[];
    timeout_ms?: number;
    poll_interval_ms?: number;
    stable_polls?: number;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: SourceReadinessResult; completed: boolean }>> {
    return withTemporaryBrowserConfig(undefined, args.show_browser, async () => {
      try {
        const url = await this.resolveNotebookUrl(
          args.notebook_id,
          args.notebook_url,
          args.session_id
        );
        const s = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          args.show_browser
        );
        const result = await s.waitForSourceReady({
          sourceNames: args.source_names,
          timeoutMs: args.timeout_ms,
          pollIntervalMs: args.poll_interval_ms,
          stablePolls: args.stable_polls,
        });
        return { success: true, data: { result, completed: result.status === "ready" } };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  async handleExportTranscript(
    args: {
      source_name: string;
      output_name?: string;
      format?: "markdown" | "json";
      max_chars?: number;
      timeout_ms?: number;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
    },
    sendProgress?: ProgressCallback
  ): Promise<
    ToolResult<{
      result: TranscriptResult;
      receipt?: WriteReceipt;
      completed: boolean;
      verifiedComplete: false;
    }>
  > {
    return withTemporaryBrowserConfig(undefined, args.show_browser, async () => {
      try {
        const url = await this.resolveNotebookUrl(
          args.notebook_id,
          args.notebook_url,
          args.session_id
        );
        const s = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          args.show_browser
        );
        const result = await s.exportTranscript(
          args.source_name,
          {
            maxChars: args.max_chars,
            timeoutMs: args.timeout_ms,
          },
          sendProgress
        );
        const receipt =
          args.output_name && result.text.trim().length > 0 && result.chunks.length > 0
            ? await writeTranscript(
                result,
                `${CONFIG.dataDir}/transcripts`,
                args.output_name,
                args.format ?? "markdown"
              )
            : undefined;
        return {
          success: true,
          data: {
            result,
            completed: result.completeness === "ui_extracted",
            verifiedComplete: false,
            ...(receipt ? { receipt } : {}),
          },
        };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /**
   * Handle generate_audio tool (issue #11).
   */
  async handleGenerateAudio(args: {
    custom_prompt?: string;
    timeout_ms?: number;
    wait_for_completion?: boolean;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult }>> {
    log.info(`🔧 [TOOL] generate_audio called`);
    return withTemporaryBrowserConfig(undefined, args.show_browser, async () => {
      const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
      try {
        const url = await this.resolveNotebookUrl(
          args.notebook_id,
          args.notebook_url,
          args.session_id
        );
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.generateAudio({
          customPrompt: args.custom_prompt,
          timeoutMs: args.timeout_ms,
          waitForCompletion: args.wait_for_completion ?? false,
        });
        // `started` and `in_progress` count as success — the generation is on
        // its way; the caller polls `get_audio_status` for completion.
        const ok =
          result.status === "ready" ||
          result.status === "started" ||
          result.status === "in_progress";
        return { success: ok, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] generate_audio failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle get_audio_status tool — non-blocking poll for Audio Overview state.
   */
  async handleGetAudioStatus(args: {
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: AudioGenerationResult }>> {
    log.info(`🔧 [TOOL] get_audio_status called`);
    return withTemporaryBrowserConfig(undefined, args.show_browser, async () => {
      const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
      try {
        const url = await this.resolveNotebookUrl(
          args.notebook_id,
          args.notebook_url,
          args.session_id
        );
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.getAudioStatus();
        return { success: true, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] get_audio_status failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Handle download_audio tool (issue #11).
   */
  async handleDownloadAudio(args: {
    destination_dir: string;
    session_id?: string;
    notebook_id?: string;
    notebook_url?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{ result: DownloadAudioResult }>> {
    log.info(`🔧 [TOOL] download_audio called`);
    return withTemporaryBrowserConfig(undefined, args.show_browser, async () => {
      const overrideHeadless = args.show_browser === undefined ? undefined : args.show_browser;
      try {
        const url = await this.resolveNotebookUrl(
          args.notebook_id,
          args.notebook_url,
          args.session_id
        );
        const session = await this.sessionManager.getOrCreateSession(
          args.session_id,
          url,
          overrideHeadless
        );
        const result = await session.downloadAudio(args.destination_dir);
        return { success: result.success, data: { result } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`❌ [TOOL] download_audio failed: ${msg}`);
        return { success: false, error: msg };
      }
    });
  }

  /**
   * Cleanup all resources (called on server shutdown)
   */
  async cleanup(): Promise<void> {
    log.info(`🧹 Cleaning up tool handlers...`);
    await this.sessionManager.closeAllSessions();
    log.success(`✅ Tool handlers cleanup complete`);
  }
}
