import assert from "node:assert/strict";
import { buildToolDefinitions } from "../dist/tools/definitions.js";
import { applyBrowserOptions, CONFIG } from "../dist/config.js";
import * as readiness from "../dist/notebooklm/source-readiness.js";
import { SettingsManager } from "../dist/utils/settings-manager.js";
import { ToolHandlers } from "../dist/tools/handlers.js";

// Contract-level workflow coverage: no browser, network, or Google mutation.
const defs = buildToolDefinitions({ getActiveNotebook: () => null });
const byName = new Map(defs.map((d) => [d.name, d]));
for (const name of ["wait_for_source_ready", "export_transcript", "add_youtube_source"]) {
  assert.ok(byName.has(name), `missing tool definition: ${name}`);
  const d = byName.get(name);
  assert.ok(d.inputSchema && d.inputSchema.type === "object", `${name} schema`);
  assert.ok(d.annotations, `${name} annotations`);
}
assert.equal(byName.get("wait_for_source_ready").annotations.readOnlyHint, true);
assert.equal(byName.get("export_transcript").annotations.readOnlyHint, false);

// Bounds are intentionally finite to prevent accidental unbounded polling/chunk loops.
for (const name of ["wait_for_source_ready", "export_transcript"]) {
  const schema = byName.get(name).inputSchema;
  for (const key of ["timeout_ms", "poll_interval_ms", "max_chunks"]) {
    const p = schema.properties?.[key];
    if (p) assert.ok(Number.isFinite(p.maximum), `${name}.${key} maximum`);
  }
}

// Source readiness envelope: ready, timeout, error and not-found remain distinguishable.
const row = (name, busy = false, error = false, readyEvidence = true) => ({ name, text: name, busy, error, readyEvidence });
assert.equal(readiness.classifySourceRows([row("S")], ["S"])[0].status, "ready");
assert.equal(readiness.classifySourceRows([row("S", true)], ["S"])[0].status, "processing");
assert.equal(readiness.classifySourceRows([row("S", false, true)], ["S"])[0].status, "error");
assert.equal(readiness.classifySourceRows([], ["S"])[0].status, "not_found");

// CONFIG serializer must be a no-op without overrides and must not mutate CONFIG.
const baseline = applyBrowserOptions();
assert.deepEqual(baseline, CONFIG);
const overridden = applyBrowserOptions({ timeout_ms: 1234, headless: true });
assert.notEqual(overridden, CONFIG);
assert.equal(overridden.browserTimeout, 1234);
assert.equal(overridden.headless, true);
assert.equal(CONFIG.browserTimeout, baseline.browserTimeout);

// Standard profiles remain discoverable and have deterministic tool lists.
const profiles = new SettingsManager().getProfiles();
assert.ok(profiles.standard && Array.isArray(profiles.standard));
assert.ok(profiles.standard.length > 0);

// Public handler target binding/envelope contracts using a mutation-free fake session.
let creates = 0;
const fakeSession = {
  notebookUrl: "https://notebooklm.google.com/notebook/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  waitForSourceReady: async () => ({ status: "timeout", overall: "timeout", sources: [], limitation: "test" }),
  // BrowserSession.exportTranscript uses direct source-viewer extraction.
  exportTranscript: async () => ({
    text: "x",
    chunks: [{ index: 0, marker: "COMPLETE", chars: 1, sha256: "test" }],
    completeness: "ui_extracted",
    warnings: [],
    provenance: {
      provider: "NotebookLM/Gemini",
      generatedByAI: null,
      transcriptOrigin: "unknown_notebooklm_rendered",
      extractionMethod: "direct_source_viewer",
      verification: "ui_extracted_not_independently_verified",
      sourceIsolation: "direct_exact_title_click",
    },
    limitations: [],
  }),
};
const library = {
  getNotebook: (id) => id === "same" ? { url: fakeSession.notebookUrl } : id === "other" ? { url: "https://notebooklm.google.com/notebook/ffffffff-ffff-4fff-8fff-ffffffffffff" } : null,
  getActiveNotebook: () => null,
};
const sessionManager = {
  getSession: (id) => id === "bound" ? fakeSession : null,
  getOrCreateSession: async () => { creates += 1; return fakeSession; },
};
const handlers = new ToolHandlers(sessionManager, {}, library);
assert.equal((await handlers.handleWaitForSourceReady({ notebook_id: "same", notebook_url: "https://notebooklm.google.com/notebook/ffffffff-ffff-4fff-8fff-ffffffffffff" })).success, false);
assert.equal((await handlers.handleWaitForSourceReady({ notebook_id: "unknown", session_id: "bound" })).success, false);
assert.equal((await handlers.handleWaitForSourceReady({ session_id: "bound", notebook_url: "https://notebooklm.google.com/notebook/ffffffff-ffff-4fff-8fff-ffffffffffff" })).success, false);
const before = creates;
const boundResult = await handlers.handleWaitForSourceReady({ session_id: "bound" });
assert.equal(boundResult.success, true);
assert.equal(boundResult.data.completed, false);
assert.equal(creates, before + 1);
const transcriptResult = await handlers.handleExportTranscript({ session_id: "bound", source_name: "S" });
assert.equal(transcriptResult.success, true);
assert.equal(transcriptResult.data.completed, true);
assert.equal(transcriptResult.data.verifiedComplete, false);

console.log("workflow integration tests: PASS");
