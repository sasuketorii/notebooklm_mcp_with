import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractTranscriptFromSourceViewer, writeTranscript } from "../dist/notebooklm/transcript-export.js";

// The extractor intentionally polls with a 150ms delay. Make the test deterministic and fast.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback, _delay, ...args) => realSetTimeout(callback, 0, ...args));

function mockPage({ texts = ["hello"], heights = [100], count = 1, error = false, restoreFails = false } = {}) {
  let poll = 0;
  let clicks = 0;
  let url = "https://example.test/notebook";
  const gotos = [];
  const scroller = { scrollHeight: 0, scrollTop: 0 };
  const element = { innerText: async () => texts[Math.min(poll++, texts.length - 1)] };
  const button = {
    count: async () => count,
    evaluate: async (fn) => fn({
      classList: { contains: () => true },
      closest: () => ({ classList: { contains: () => error, }, querySelector: () => error }),
      click: () => { clicks++; },
    }),
  };
  const locator = (name) => {
    if (name === "source-viewer") return { waitFor: async () => {}, locator };
    if (name === ".elements-container") return { waitFor: async () => {}, innerText: element.innerText };
    if (name === ".scroll-container") return {
      evaluate: async (fn) => {
        const result = fn(scroller);
        if (result && typeof result === "object") {
          const n = Math.min(Math.max(poll - 1, 0), heights.length - 1);
          scroller.scrollHeight = heights[n];
          scroller.scrollTop = heights[n];
          return { height: scroller.scrollHeight, top: scroller.scrollTop };
        }
        return result;
      },
    };
    if (name === ".single-source-container .source-title") return { first: () => ({ waitFor: async () => {} }) };
    return { waitFor: async () => {} };
  };
  return {
    page: {
      url: () => url,
      getByRole: () => button,
      locator,
      goto: async (next) => { gotos.push(next); if (restoreFails) throw new Error("restore failed"); url = next; },
      keyboard: { press: async () => {} },
    },
    clicks: () => clicks,
    gotos: () => gotos,
  };
}

for (const spec of [{ count: 0, msg: /not found/ }, { count: 2, msg: /Ambiguous/ }])
  await assert.rejects(() => extractTranscriptFromSourceViewer(mockPage(spec).page, "S"), spec.msg);

const bad = mockPage({ error: true });
await assert.rejects(() => extractTranscriptFromSourceViewer(bad.page, "S"), /processing error/);
assert.equal(bad.clicks(), 0, "source-error rows must never be clicked");

// Text and scroll metrics grow for several polls; extraction must not settle early.
const delayed = mockPage({ texts: ["hello", "hello world", "hello world", "hello world", "hello world"], heights: [100, 200, 200, 200, 200] });
const result = await extractTranscriptFromSourceViewer(delayed.page, "S");
assert.equal(result.text, "hello world");
assert.equal(result.completeness, "ui_extracted");
assert.deepEqual(delayed.gotos(), ["https://example.test/notebook"]);

const failed = mockPage({ error: true });
await assert.rejects(() => extractTranscriptFromSourceViewer(failed.page, "S"), /processing error/);
assert.deepEqual(failed.gotos(), ["https://example.test/notebook"], "original URL is restored after failure");

const partial = await extractTranscriptFromSourceViewer(mockPage({ texts: ["abcdef"] }).page, "S", { maxChars: 3 });
assert.equal(partial.completeness, "partial");
assert.equal(partial.text, "abc");
assert.match(partial.warnings.join(), /maxChars/);

// A never-settling viewer is bounded by the poll limit and returns a warned partial result.
const unsettled = mockPage({ texts: ["still loading"], heights: Array.from({ length: 81 }, (_, i) => i + 1) });
const bounded = await extractTranscriptFromSourceViewer(unsettled.page, "S", { timeoutMs: 30_000 });
assert.equal(bounded.completeness, "partial");
assert.match(bounded.warnings.join(), /settle limit|deadline/);

const dir = await mkdtemp(path.join(tmpdir(), "nle-"));
const receipt = await writeTranscript(result, dir, "out", "markdown");
assert.equal(receipt.bytes, (await readFile(receipt.path)).byteLength);
console.log("transcript export tests: PASS");
