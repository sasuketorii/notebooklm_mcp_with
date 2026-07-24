/**
 * MCP tool definitions for source ingestion + Audio Overview (issues #25, #11).
 *
 * The cross-tool async-audio chain (generate → poll → download) is documented
 * in the server-level `instructions` string (see src/index.ts) so individual
 * descriptions stay focused on one operation each.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const sharedNotebookTargeting = {
  session_id: {
    type: "string",
    description:
      "Reuse an existing browser session by id. Recommended when you have " +
      "already called `ask_question` against the same notebook — saves the " +
      "10–15 s page-load time. Obtain from `list_sessions` or any prior " +
      "`ask_question` response (`result.session_id`).",
  },
  notebook_id: {
    type: "string",
    description:
      "Library notebook id (from `list_notebooks` / `search_notebooks`). " +
      "Defaults to the active notebook (see `select_notebook`) when omitted.",
  },
  notebook_url: {
    type: "string",
    description:
      "Direct NotebookLM URL for ad-hoc notebooks. If supplied with `notebook_id`, " +
      "both must resolve to the same known notebook; unknown or mismatched targets fail closed. Format: " +
      "`https://notebooklm.google.com/notebook/<uuid>`.",
  },
};

export const addSourceTool: Tool = {
  name: "add_source",
  description:
    "Ingest a source into a NotebookLM notebook. Supports two source types " +
    "in v2.0:\n" +
    "  • `url` — NotebookLM crawls and indexes a website\n" +
    "  • `text` — paste raw text (treated as a copied document)\n\n" +
    "For YouTube use `add_youtube_source`; Google Drive and general file uploads are not implemented.\n\n" +
    "Returns `sourceCountBefore`/`sourceCountAfter` so the caller can verify " +
    "the new source landed. Call once per source — multiple sources require " +
    "multiple calls. NotebookLM finishes indexing within 5–30 seconds; " +
    "subsequent `ask_question` calls then have the new source in context. " +
    "Free notebooks cap at 50 sources.\n\n" +
    "Known quirk: pasted-text uploads occasionally redirect to a freshly " +
    'created "Untitled notebook" on Google\'s side. The tool detects this ' +
    "and returns a clear error so you can re-try against the correct URL.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["url", "text"],
        description:
          "`url` crawls the supplied website; `text` ingests `content` " +
          "verbatim as a copied document.",
      },
      content: {
        type: "string",
        description:
          "When `type=url`: a fully-qualified URL (https://…). " +
          "When `type=text`: the raw text body (any length up to NotebookLM's per-source word limit, ~500 k for free tier).",
      },
      title: {
        type: "string",
        description:
          "Display title shown in the source list. Optional — NotebookLM " +
          "picks a sensible default (page title for URLs, first line for text). " +
          "For text sources, supplying a title is recommended for later " +
          "identification.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["type", "content"],
  },
  annotations: {
    title: "Add source to notebook",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const addAudioSourceTool: Tool = {
  name: "add_audio_source",
  description:
    "Upload one or more local audio files to a NotebookLM notebook using NotebookLM's own " +
    "file-upload UI. This tool does not transcribe, decode, or send audio to any external ASR. " +
    "It validates canonical regular-file paths and returns a receipt with SHA-256 hashes, byte sizes, " +
    "and source-panel verification. Supported extensions: mp3, m4a, aac, wav, flac, ogg, opus. " +
    "Limits: 10 files, 200 MiB per file, 500 MiB total. NotebookLM indexing remains asynchronous after upload.",
  inputSchema: {
    type: "object",
    properties: {
      file_paths: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: { type: "string" },
        description:
          "Absolute or resolvable local paths to audio files. The server resolves symlinks before upload and rejects duplicates.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the NotebookLM browser window while uploading. Default: false.",
      },
      timeout_ms: {
        type: "number",
        minimum: 30000,
        maximum: 1200000,
        description: "Confirmation wait in milliseconds. Default 900000; allowed 30000–1200000.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["file_paths"],
  },
  annotations: {
    title: "Upload local audio source(s)",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const generateAudioTool: Tool = {
  name: "generate_audio",
  description:
    "Trigger podcast-style Audio Overview generation for a notebook.\n\n" +
    "**Async by default** — returns immediately with one of:\n" +
    '  • `status: "started"` — generation just kicked off\n' +
    '  • `status: "in_progress"` — a generation was already running; ' +
    "this call attached to it\n" +
    '  • `status: "ready"` (with `alreadyExisted: true`) — an Audio ' +
    "Overview already existed; nothing was triggered\n\n" +
    "Generation typically takes 2–10 minutes. **Workflow:**\n" +
    "  1. `generate_audio` → returns immediately\n" +
    "  2. Poll `get_audio_status` every ~30 s\n" +
    "  3. When status is `ready`, call `download_audio`\n\n" +
    "Pass `wait_for_completion: true` for legacy synchronous behaviour " +
    "(blocks for up to `timeout_ms`). Audio Overview is the only Studio " +
    "output exposed in v2.0 (Video / Mindmap / Quiz / Infographic / " +
    "Datatable / Presentation are NotebookLM features but not yet wrapped).",
  inputSchema: {
    type: "object",
    properties: {
      custom_prompt: {
        type: "string",
        description:
          'Optional focus prompt for the Audio Overview, e.g. "Focus on the ' +
          'API authentication flow and skip pricing". Passed into the ' +
          'NotebookLM "Customize" sub-dialog before generation starts.',
      },
      wait_for_completion: {
        type: "boolean",
        description:
          "If true, block until the audio tile is ready (up to `timeout_ms`). " +
          "Default false — return immediately and let the caller poll " +
          "`get_audio_status`.",
      },
      timeout_ms: {
        type: "number",
        description:
          "Only relevant when `wait_for_completion=true`. Maximum wait for " +
          "the audio tile to appear. Default 600 000 (10 min).",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Generate Audio Overview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true, // Idempotent: existing audio is detected and returned as ready
    openWorldHint: true,
  },
};

export const getAudioStatusTool: Tool = {
  name: "get_audio_status",
  description:
    "Non-blocking probe for the current Audio Overview state of a notebook.\n\n" +
    "Returned `status` values:\n" +
    "  • `ready` — Audio Overview is generated and ready to download\n" +
    "  • `in_progress` — generation is currently running\n" +
    "  • `not_started` — no Audio Overview exists yet for this notebook\n\n" +
    "Safe to poll every ~30 s while waiting for `generate_audio` to finish. " +
    "When status flips to `ready`, call `download_audio` with a destination " +
    "directory.",
  inputSchema: {
    type: "object",
    properties: {
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
  },
  annotations: {
    title: "Get Audio Overview status",
    readOnlyHint: true,
    openWorldHint: true,
  },
};

export const downloadAudioTool: Tool = {
  name: "download_audio",
  description:
    "Save the completed Audio Overview to disk as a `.m4a` file. **Pre-" +
    'condition:** `get_audio_status` must report `status: "ready"`. ' +
    "Calling this before generation completes returns an error message " +
    "explaining what to do.\n\n" +
    "The file lands in `destination_dir` with NotebookLM's suggested " +
    "filename (sanitised — usually the audio's title with underscores). " +
    "The full saved path is returned in `result.filePath`.",
  inputSchema: {
    type: "object",
    properties: {
      destination_dir: {
        type: "string",
        description:
          "Absolute directory path where the file is saved (created if " +
          "missing). Use an absolute path such as `<data-dir>/audio` or " +
          "`/tmp/audio`. Relative paths are NOT recommended — the server " +
          "may run from a different working directory than the caller.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window for debugging. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["destination_dir"],
  },
  annotations: {
    title: "Download Audio Overview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const addYouTubeSourceTool: Tool = {
  name: "add_youtube_source",
  description:
    "Add one public YouTube video to the selected NotebookLM notebook. " +
    "The tool verifies the source-list row after submission; it does not claim that indexing or transcript generation is complete. " +
    "Use wait_for_source_ready before asking NotebookLM questions about the video.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        maxLength: 2048,
        description:
          "HTTPS YouTube watch URL (youtube.com/watch?v=... or youtu.be/...). Tracking parameters are tolerated; credentials and non-YouTube hosts are rejected.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: 1200000,
        description:
          "Maximum time in milliseconds for the browser upload and source-row verification. Default: 120000.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window while adding the source. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["url"],
    additionalProperties: false,
  },
  annotations: {
    title: "Add YouTube source",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};
export const waitForSourceReadyTool: Tool = {
  name: "wait_for_source_ready",
  description:
    "Wait until every named source has positive, stable readiness evidence in the NotebookLM source list. " +
    "A timeout, missing source, error state, or zero-row observation is reported as not ready; no readiness is inferred from absence of evidence.",
  inputSchema: {
    type: "object",
    properties: {
      source_names: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        uniqueItems: true,
        items: {
          type: "string",
          maxLength: 300,
          description: "Exact source-list title to observe.",
        },
        description: "One to ten exact source names; all must be ready.",
      },
      poll_interval_ms: {
        type: "integer",
        minimum: 50,
        maximum: 30000,
        description: "Delay between DOM probes in milliseconds. Default: 1000.",
      },
      stable_polls: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Number of consecutive ready probes required. Default: 2.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window while polling. Default: false.",
      },
      ...sharedNotebookTargeting,
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: 600000,
        description: "Overall readiness wait in milliseconds. Default: 90000.",
      },
    },
    required: ["source_names"],
    additionalProperties: false,
  },
  annotations: {
    title: "Wait for source readiness",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};
export const exportTranscriptTool: Tool = {
  name: "export_transcript",
  description:
    "Open one exact source by title in NotebookLM's source viewer and extract its rendered transcript as Markdown or JSON. " +
    "This is direct UI extraction (not model-claimed chat output), is not independently verified against original media, and partial results are explicitly marked.",
  inputSchema: {
    type: "object",
    properties: {
      source_name: {
        type: "string",
        maxLength: 300,
        description: "Exact source-list title to transcribe.",
      },
      output_name: {
        type: "string",
        maxLength: 120,
        pattern: "^[A-Za-z0-9._-]+$",
        description: "Optional safe output filename stem; path separators are rejected.",
      },
      format: {
        type: "string",
        enum: ["markdown", "json"],
        description: "Output serialization. Default: markdown.",
      },
      max_chars: {
        type: "integer",
        minimum: 1,
        maximum: 1000000,
        description: "Maximum transcript characters retained across chunks. Default: 1000000.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 30000,
        maximum: 1800000,
        description: "Overall transcript export deadline in milliseconds. Default: 120000.",
      },
      show_browser: {
        type: "boolean",
        description: "Show the browser window while exporting. Default: false.",
      },
      ...sharedNotebookTargeting,
    },
    required: ["source_name"],
    additionalProperties: false,
  },
  annotations: {
    title: "Export transcript",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const sourceTools: Tool[] = [
  addSourceTool,
  addAudioSourceTool,
  addYouTubeSourceTool,
  waitForSourceReadyTool,
  exportTranscriptTool,
  generateAudioTool,
  getAudioStatusTool,
  downloadAudioTool,
];
