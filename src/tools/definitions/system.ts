import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * System / auth / cleanup tools. The cross-tool first-run workflow lives in
 * the server-level `instructions` string (see src/index.ts) so individual
 * descriptions stay focused on what each tool does, not how the suite
 * fits together.
 */
export const systemTools: Tool[] = [
  {
    name: "get_health",
    description:
      "Inspect server state. Returns:\n" +
      "  • `authenticated`, `auth_status`, `auth_evidence` — live runtime verification or conservative recovery-snapshot evidence\n" +
      "  • `notebook_url`, `active_notebook_id`, `active_notebook_name` —\n" +
      "    the currently selected library notebook (or null)\n" +
      "  • `total_notebooks` — library size\n" +
      "  • `active_sessions`, `max_sessions`, `session_timeout` — runtime\n" +
      "    session stats (timeout in seconds; sessions auto-close after this)\n" +
      "  • `headless`, `auto_login_enabled`, `stealth_enabled` — config\n" +
      "Use this first thing in a new conversation. `authenticated=true` means either " +
      "this process completed a live NotebookLM readiness check or the recovery snapshot " +
      "contains unexpired persistent-cookie evidence; it is not proof that Google currently " +
      "accepts saved cookies. This check does not open a browser or contact Google.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      title: "Get server health",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "setup_auth",
    description:
      "Open a browser window for first-time Google login. The call waits while " +
      "the user completes sign-in, for up to 10 minutes, and then cookies are " +
      "persisted for future runs. This preserves any " +
      "existing persistent profile/state. A conflicting owner returns `profile_busy`.\n\n" +
      "When to use:\n" +
      "  • `get_health` reports `snapshot_missing`, `snapshot_expired`, or `snapshot_malformed`\n" +
      "  • Auto-login credentials are not configured\n" +
      "  • Use a distinct account data directory to switch accounts\n\n" +
      "After login finishes, call `get_health` to verify success.\n\n" +
      "If the browser session feels broken, inspect with `cleanup_data(confirm=false, preserve_library=true)` and retry `setup_auth`; destructive cleanup is unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        show_browser: {
          type: "boolean",
          description:
            "Show the browser window. Default: true (must be visible so the " +
            "user can interact). For advanced control use `browser_options`.",
        },
        browser_options: {
          type: "object",
          description:
            "Advanced browser settings. Override visibility, timeout, or " +
            "headless mode (default: visible, 30 s).",
          properties: {
            show: { type: "boolean" },
            headless: { type: "boolean" },
            timeout_ms: { type: "number" },
          },
        },
      },
    },
    annotations: {
      title: "Set up Google authentication",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "re_auth",
    description:
      "Unavailable. This tool always returns `re_auth_unavailable` without launching a browser, changing configuration, rotating accounts, wiping authentication, or touching files.",
    inputSchema: {
      type: "object",
      properties: {
        show_browser: {
          type: "boolean",
          description:
            "Compatibility argument only. Accepted but ignored because re_auth is unavailable.",
        },
        browser_options: {
          type: "object",
          description:
            "Compatibility argument only. Accepted but ignored because re_auth is unavailable.",
          properties: {
            show: { type: "boolean" },
            headless: { type: "boolean" },
            timeout_ms: { type: "number" },
          },
        },
      },
    },
    annotations: {
      title: "Re-authentication unavailable",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "cleanup_data",
    description:
      "Inspect server data paths that would require manual cleanup (auth state, " +
      "browser profiles, caches, MCP logs, temp backups). This tool is " +
      "strictly non-mutating and never deletes files.\n\n" +
      "Call with `confirm: false` for a categorised non-mutating preview. " +
      "`confirm: true` returns `cleanup_unavailable` and performs no deletion.\n\n" +
      "`preserve_library=true` filters library-related paths out of the hypothetical preview. " +
      "It never causes deletion.\n\n" +
      "Typical recovery flow: cleanup_data(confirm=false, preserve_library=true) // preview, then setup_auth if needed",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          description: "false = preview only (default). true = unsupported with no side effects.",
        },
        preserve_library: {
          type: "boolean",
          description:
            "Preview filter. true excludes library-related paths from the hypothetical cleanup list. No files are deleted.",
          default: false,
        },
      },
      required: ["confirm"],
    },
    annotations: {
      title: "Preview cleanup paths",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
