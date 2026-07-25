#!/usr/bin/env node

/**
 * NotebookLM MCP Server
 *
 * MCP Server for Google NotebookLM - Chat with Gemini 2.5 through NotebookLM
 * with session support and human-like behavior!
 *
 * Features:
 * - Session-based contextual conversations
 * - Auto re-login on session expiry
 * - Human-like typing and mouse movements
 * - Persistent browser fingerprint
 * - Stealth mode with Patchright
 * - Claude Code integration via npx
 *
 * Usage:
 *   npx notebooklm-mcp
 *   node dist/index.js
 *
 * Environment Variables:
 *   NOTEBOOK_URL - Default NotebookLM notebook URL
 *   AUTO_LOGIN_ENABLED - Enable automatic login (true/false)
 *   LOGIN_EMAIL - Google email for auto-login
 *   LOGIN_PASSWORD - Google password for auto-login
 *   HEADLESS - Run browser in headless mode (true/false)
 *   MAX_SESSIONS - Maximum concurrent sessions (default: 10)
 *   SESSION_TIMEOUT - Session timeout in seconds (default: 900)
 *
 * Based on the Python NotebookLM API implementation
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { AuthManager } from "./auth/auth-manager.js";
import { applyAccountToConfig, getRequestedAccount } from "./auth/account-switcher.js";
import { SessionManager } from "./session/session-manager.js";
import { NotebookLibrary } from "./library/notebook-library.js";
import { ToolHandlers, buildToolDefinitions } from "./tools/index.js";
import { ResourceHandlers } from "./resources/resource-handlers.js";
import { SettingsManager } from "./utils/settings-manager.js";
import { CliHandler } from "./utils/cli-handler.js";
import { CONFIG, ensureDirectories } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { startHttpTransport, type HttpTransportHandle } from "./transport/http.js";
import { log } from "./utils/logger.js";

/**
 * Server-level instructions consumed by MCP clients during initialization.
 * Per the MCP spec, these describe **cross-tool workflows, ID flows, and
 * constraints** so an LLM agent can use the server end-to-end without prior
 * context. We deliberately keep individual tool descriptions terse — no
 * duplicating workflow advice across every tool.
 *
 * Reference: modelcontextprotocol typescript-sdk → "Server instructions".
 */
const SERVER_INSTRUCTIONS = `# notebooklm-mcp — research with Google NotebookLM

This server lets an LLM run a fully session-based research workflow against
a NotebookLM notebook (chat with Gemini 2.5 grounded on user-uploaded
sources, ingest sources, generate Audio Overviews).

## First-run flow

1. \`get_health\` → inspect \`auth_status\` and \`auth_evidence\`. This is
   offline and does not claim that Google currently accepts a saved cookie.
   Run \`setup_auth\` when authentication is needed (it opens a browser tab).
2. \`add_notebook\` to register a NotebookLM share-URL into the local
   library (the user must provide the URL — see add_notebook for the link
   workflow). Optionally \`select_notebook\` to make it the default.
3. \`ask_question\` — start asking. Save the returned \`session_id\` and
   reuse it for follow-up questions to keep context.

## Notebook ID flow

\`list_notebooks\` / \`search_notebooks\` / \`get_notebook\` all return
notebook objects with an \`id\` field. That \`id\` feeds
\`select_notebook\`, \`update_notebook\`, \`remove_notebook\`, and the
optional \`notebook_id\` argument on \`ask_question\` / \`add_source\` /
audio tools.

## Session ID flow

\`ask_question\` returns \`session_id\` on every call. Pass that same id
back as \`session_id\` on later \`ask_question\` calls to maintain a
conversational context (NotebookLM uses session-RAG so follow-ups get
sharper). \`list_sessions\` enumerates live sessions; \`reset_session\`
clears chat history (same id), \`close_session\` ends a session.

## Source ingestion (multi-source)

Call \`add_source\` once per URL/text source. For local audio, call
\`add_audio_source\` with one or more local file paths; it uses NotebookLM's
file chooser and returns hashes plus source-panel verification.
NotebookLM crawls/indexes each source asynchronously; new sources are
typically queryable within 5–30 seconds after \`add_source\` succeeds.

## Audio Overview (async chain — important)

\`generate_audio\` is **non-blocking** by default: it triggers the render
and returns immediately with \`status: "started"\` (or \`"in_progress"\` if
a generation was already running, or \`"ready"\` if one already existed).
Generation typically takes 2–10 minutes.

To complete the workflow, poll \`get_audio_status\` every ~30 s. When it
returns \`status: "ready"\`, call \`download_audio\` with an absolute
\`destination_dir\` to save the file. Calling \`download_audio\` before
\`ready\` will surface a clear error.

For synchronous behaviour pass \`wait_for_completion: true\` to
\`generate_audio\` (legacy mode — blocks for up to \`timeout_ms\`).

## Constraints

- Free Google accounts: 50 NotebookLM queries/day. Account rotation is not
  supported by this server; use a separate account data directory.
- Session timeout: ~15 min idle (see \`get_health.session_timeout\`).
- YouTube sources, readiness polling, and transcript export are supported; Drive and general file uploads are not.
- Audio Overview is the only Studio output exposed in v2.0; Video,
  Presentation, Mindmap, Flashcards, Quiz, Infographic, and Datatable are
  generated by NotebookLM but not yet wrapped by this server.
`;

/**
 * MCP progress tokens are carried in `_meta.progressToken` on the tool-call
 * arguments object. The SDK types arguments as `Record<string, unknown>`,
 * so we narrow defensively.
 */
function extractProgressToken(
  args: Record<string, unknown> | undefined
): string | number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const meta = (args as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const token = (meta as { progressToken?: unknown }).progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

/**
 * Main MCP Server Class
 */
interface NotebookLMCore {
  authManager: AuthManager;
  sessionManager: SessionManager;
  library: NotebookLibrary;
  toolHandlers: ToolHandlers;
  resourceHandlers: ResourceHandlers;
  settingsManager: SettingsManager;
  toolDefinitions: Tool[];
}

class NotebookLMMCPServer {
  private server: Server;
  private toolHandlers: ToolHandlers;
  private resourceHandlers: ResourceHandlers;
  private settingsManager: SettingsManager;
  private toolDefinitions: Tool[];
  private core: NotebookLMCore;
  private httpHandle?: HttpTransportHandle;

  constructor(registerShutdownHandlers: boolean = true, sharedCore?: NotebookLMCore) {
    // Initialize MCP Server
    this.server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          completions: {}, // Required for completion/complete support
          logging: {},
        },
        // MCP-spec server instructions (clients merge into the system prompt).
        // Use these for cross-tool workflow guidance — do not duplicate
        // information that already lives in individual tool descriptions.
        instructions: SERVER_INSTRUCTIONS,
      }
    );

    if (sharedCore) {
      this.core = sharedCore;
    } else {
      const authManager = new AuthManager();
      const sessionManager = new SessionManager(authManager);
      const library = new NotebookLibrary();
      const settingsManager = new SettingsManager();
      const toolHandlers = new ToolHandlers(sessionManager, authManager, library);
      const resourceHandlers = new ResourceHandlers(library);
      const allTools = buildToolDefinitions(library) as Tool[];
      this.core = {
        authManager,
        sessionManager,
        library,
        settingsManager,
        toolHandlers,
        resourceHandlers,
        toolDefinitions: settingsManager.filterTools(allTools),
      };
    }
    this.settingsManager = this.core.settingsManager;
    this.toolHandlers = this.core.toolHandlers;
    this.resourceHandlers = this.core.resourceHandlers;
    this.toolDefinitions = this.core.toolDefinitions;

    // Setup handlers
    this.setupHandlers();
    if (registerShutdownHandlers) this.setupShutdownHandlers();

    const activeSettings = this.settingsManager.getEffectiveSettings();
    log.info("🚀 NotebookLM MCP Server initialized");
    log.info(`  Version: ${SERVER_VERSION}`);
    log.info(`  Node: ${process.version}`);
    log.info(`  Platform: ${process.platform}`);
    log.info(`  Profile: ${activeSettings.profile} (${this.toolDefinitions.length} tools active)`);
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // Register Resource Handlers (Resources, Templates, Completions)
    this.resourceHandlers.registerHandlers(this.server);

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      log.info("📋 [MCP] list_tools request received");
      return {
        tools: this.toolDefinitions,
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const progressToken = extractProgressToken(args);

      log.info(`🔧 [MCP] Tool call: ${name}`);
      if (progressToken) {
        log.info(`  📊 Progress token: ${progressToken}`);
      }

      // Create progress callback function
      const sendProgress = async (message: string, progress?: number, total?: number) => {
        if (progressToken) {
          await this.server.notification({
            method: "notifications/progress",
            params: {
              progressToken,
              message,
              ...(progress !== undefined && { progress }),
              ...(total !== undefined && { total }),
            },
          });
          log.dim(`  📊 Progress: ${message}`);
        }
      };

      try {
        let result;

        switch (name) {
          case "ask_question":
            result = await this.toolHandlers.handleAskQuestion(
              args as {
                question: string;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
                source_format?: "none" | "inline" | "footnotes" | "json";
              },
              sendProgress
            );
            break;

          case "add_notebook":
            result = await this.toolHandlers.handleAddNotebook(
              args as {
                url: string;
                name: string;
                description: string;
                topics: string[];
                content_types?: string[];
                use_cases?: string[];
                tags?: string[];
              }
            );
            break;

          case "list_notebooks":
            result = await this.toolHandlers.handleListNotebooks();
            break;

          case "get_notebook":
            result = await this.toolHandlers.handleGetNotebook(args as { id: string });
            break;

          case "select_notebook":
            result = await this.toolHandlers.handleSelectNotebook(args as { id: string });
            break;

          case "update_notebook":
            result = await this.toolHandlers.handleUpdateNotebook(
              args as {
                id: string;
                name?: string;
                description?: string;
                topics?: string[];
                content_types?: string[];
                use_cases?: string[];
                tags?: string[];
                url?: string;
              }
            );
            break;

          case "remove_notebook":
            result = await this.toolHandlers.handleRemoveNotebook(args as { id: string });
            break;

          case "search_notebooks":
            result = await this.toolHandlers.handleSearchNotebooks(args as { query: string });
            break;

          case "get_library_stats":
            result = await this.toolHandlers.handleGetLibraryStats();
            break;

          case "list_sessions":
            result = await this.toolHandlers.handleListSessions();
            break;

          case "close_session":
            result = await this.toolHandlers.handleCloseSession(args as { session_id: string });
            break;

          case "reset_session":
            result = await this.toolHandlers.handleResetSession(args as { session_id: string });
            break;

          case "get_health":
            result = await this.toolHandlers.handleGetHealth();
            break;

          case "setup_auth":
            result = await this.toolHandlers.handleSetupAuth(
              args as { show_browser?: boolean },
              sendProgress
            );
            break;

          case "re_auth":
            result = await this.toolHandlers.handleReAuth(
              args as { show_browser?: boolean },
              sendProgress
            );
            break;

          case "cleanup_data":
            result = await this.toolHandlers.handleCleanupData(args as { confirm: boolean });
            break;

          case "add_source":
            result = await this.toolHandlers.handleAddSource(
              args as {
                type: "url" | "text";
                content: string;
                title?: string;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
              }
            );
            break;

          case "add_audio_source":
            result = await this.toolHandlers.handleAddAudioSource(
              args as {
                file_paths: string[];
                timeout_ms?: number;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "add_youtube_source":
            result = await this.toolHandlers.handleAddYouTubeSource(
              args as Record<string, unknown> as Parameters<
                typeof this.toolHandlers.handleAddYouTubeSource
              >[0]
            );
            break;
          case "wait_for_source_ready":
            result = await this.toolHandlers.handleWaitForSourceReady(
              args as Record<string, unknown> as Parameters<
                typeof this.toolHandlers.handleWaitForSourceReady
              >[0]
            );
            break;
          case "export_transcript":
            result = await this.toolHandlers.handleExportTranscript(
              args as Record<string, unknown> as Parameters<
                typeof this.toolHandlers.handleExportTranscript
              >[0],
              sendProgress
            );
            break;

          case "generate_audio":
            result = await this.toolHandlers.handleGenerateAudio(
              args as {
                custom_prompt?: string;
                timeout_ms?: number;
                wait_for_completion?: boolean;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "get_audio_status":
            result = await this.toolHandlers.handleGetAudioStatus(
              args as {
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          case "download_audio":
            result = await this.toolHandlers.handleDownloadAudio(
              args as {
                destination_dir: string;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              }
            );
            break;

          default:
            log.error(`❌ [MCP] Unknown tool: ${name}`);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: false,
                      error: `Unknown tool: ${name}`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
        }

        // Return result
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`❌ [MCP] Tool execution error: ${errorMessage}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: errorMessage,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    let shuttingDown = false;

    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      log.info(`\n🛑 Received ${signal}, shutting down gracefully...`);

      // Hard ceiling on cleanup so a wedged browser context can't keep the
      // process alive (issue #29 — orphan Chrome on macOS after MCP reconnects).
      // After 5 s we give up gracefully and let `process.exit` reap children.
      const watchdog = setTimeout(() => {
        log.error("⏱️  Shutdown stalled — forcing exit (issue #29 watchdog)");
        process.exit(1);
      }, 5_000);
      watchdog.unref();

      try {
        await this.httpHandle?.close();
        await this.toolHandlers.cleanup();
        await this.server.close();
        log.success("✅ Shutdown complete");
        clearTimeout(watchdog);
        process.exit(0);
      } catch (error) {
        log.error(`❌ Error during shutdown: ${error}`);
        clearTimeout(watchdog);
        process.exit(1);
      }
    };

    const requestShutdown = (signal: string) => {
      void shutdown(signal);
    };

    process.on("SIGINT", () => requestShutdown("SIGINT"));
    process.on("SIGTERM", () => requestShutdown("SIGTERM"));

    process.on("uncaughtException", (error) => {
      log.error(`💥 Uncaught exception: ${error}`);
      log.error(error.stack || "");
      requestShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason, promise) => {
      log.error(`💥 Unhandled rejection at: ${promise}`);
      log.error(`Reason: ${reason}`);
      requestShutdown("unhandledRejection");
    });
  }

  /**
   * Start the MCP server using stdio (default) or HTTP transport (issue #4).
   */
  async start(options: TransportOptions = { kind: "stdio" }): Promise<void> {
    log.info("🎯 Starting NotebookLM MCP Server...");
    log.info("");
    log.info("📝 Configuration:");
    log.info(`  Config Dir: ${CONFIG.configDir}`);
    log.info(`  Data Dir: ${CONFIG.dataDir}`);
    log.info(`  Headless: ${CONFIG.headless}`);
    log.info(`  Max Sessions: ${CONFIG.maxSessions}`);
    log.info(`  Session Timeout: ${CONFIG.sessionTimeout}s`);
    log.info(`  Stealth: ${CONFIG.stealthEnabled}`);
    log.info(`  Transport: ${options.kind}`);
    log.info("");

    if (options.kind === "http") {
      this.httpHandle = await startHttpTransport({
        port: options.port,
        host: options.host,
        connect: async (transport) => {
          // MCP Server instances are single-transport. A fresh facade per
          // Streamable-HTTP session prevents cross-client state leakage.
          await new NotebookLMMCPServer(false, this.core).server.connect(transport);
        },
      });
      log.success("✅ MCP Server connected via Streamable HTTP");
    } else {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      log.success("✅ MCP Server connected via stdio");
    }

    log.success("🎉 Ready to receive requests from Claude Code!");
    log.info("");
    log.info("💡 Available tools:");
    for (const tool of this.toolDefinitions) {
      const desc = tool.description ? tool.description.split("\n")[0] : "No description";
      log.info(`  - ${tool.name}: ${desc.substring(0, 80)}...`);
    }
    log.info("");
    log.info("📖 For documentation, see: README.md");
    log.info("");
  }
}

type TransportOptions = { kind: "stdio" } | { kind: "http"; port: number; host?: string };

function parseTransportOptions(argv: readonly string[]): TransportOptions {
  let kind: "stdio" | "http" = "stdio";
  let port = 3000;
  let host: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--transport") {
      const next = argv[i + 1];
      if (next === "http" || next === "stdio") {
        kind = next;
        i++;
      }
    } else if (arg.startsWith("--transport=")) {
      const value = arg.slice("--transport=".length);
      if (value === "http" || value === "stdio") kind = value;
    } else if (arg === "--port") {
      const next = argv[i + 1];
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
      if (Number.isFinite(parsed)) {
        port = parsed;
        i++;
      }
    } else if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isFinite(parsed)) port = parsed;
    } else if (arg === "--host") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        host = next;
        i++;
      }
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    }
  }

  // Env-var fallbacks for hosted deployments.
  const envTransport = process.env.NOTEBOOKLM_TRANSPORT;
  if (envTransport === "http" || envTransport === "stdio") kind = envTransport;
  const envPort = process.env.NOTEBOOKLM_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isFinite(parsed)) port = parsed;
  }
  const envHost = process.env.NOTEBOOKLM_HOST;
  if (envHost) host = envHost;

  if (kind === "http") return { kind, port, host };
  return { kind: "stdio" };
}

/**
 * Main entry point
 */
async function main() {
  // Handle CLI commands
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] === "config") {
    const cli = new CliHandler();
    await cli.handleCommand(args);
    process.exit(0);
  }

  // Apply --account / NOTEBOOKLM_ACCOUNT before any directory or browser is
  // touched (issue #2). The account-switcher rewrites CONFIG paths so each
  // Google account gets an isolated Chrome profile + auth state directory.
  const account = getRequestedAccount();
  if (account) {
    applyAccountToConfig(CONFIG, account);
    ensureDirectories();
    log.info(`👤 Account profile active: ${account}`);
  }

  // Print banner
  console.error("╔══════════════════════════════════════════════════════════╗");
  console.error("║                                                          ║");
  console.error(`║       NotebookLM MCP Server v${SERVER_VERSION}          ║`);
  console.error("║                                                          ║");
  console.error("║   Chat with Gemini 2.5 through NotebookLM via MCP       ║");
  console.error("║                                                          ║");
  console.error("╚══════════════════════════════════════════════════════════╝");
  console.error("");

  try {
    const transportOptions = parseTransportOptions(args);
    const server = new NotebookLMMCPServer();
    await server.start(transportOptions);
  } catch (error) {
    log.error(`💥 Fatal error starting server: ${error}`);
    if (error instanceof Error) {
      log.error(error.stack || "");
    }
    process.exit(1);
  }
}

// Run the server
main();
