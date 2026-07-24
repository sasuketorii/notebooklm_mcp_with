import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Page } from "patchright";
import path from "node:path";

export type Completeness = "ui_extracted" | "complete_claimed" | "partial" | "indeterminate";
export interface TranscriptChunk {
  index: number;
  marker: "MORE" | "COMPLETE";
  chars: number;
  sha256: string;
}
export interface TranscriptResult {
  text: string;
  chunks: TranscriptChunk[];
  completeness: Completeness;
  warnings: string[];
  provenance: {
    provider: "NotebookLM/Gemini";
    generatedByAI: null;
    transcriptOrigin: "unknown_notebooklm_rendered";
    verification: "ui_extracted_not_independently_verified";
    sourceIsolation: "direct_exact_title_click";
  };
  limitations: string[];
}
export interface WriteReceipt {
  path: string;
  format: "markdown" | "json";
  bytes: number;
  sha256: string;
}
const LIMITS = {
  maxChunks: 32,
  maxChars: 1_000_000,
  minTimeout: 30_000,
  maxTimeout: 1_800_000,
};

/** Extracts the verbatim transcript rendered by NotebookLM's source viewer. */
export async function extractTranscriptFromSourceViewer(
  page: Page,
  sourceName: string,
  options: { maxChars?: number; timeoutMs?: number } = {}
): Promise<TranscriptResult> {
  validSource(sourceName);
  const maxChars = finiteInt(options.maxChars, LIMITS.maxChars, 1, LIMITS.maxChars);
  const timeoutMs = finiteInt(options.timeoutMs, 120_000, LIMITS.minTimeout, LIMITS.maxTimeout);
  const deadline = Date.now() + timeoutMs;
  const originalUrl = page.url();
  let settled = false;
  const button = page.getByRole("button", { name: sourceName, exact: true });
  const buttonCount = await button.count();
  if (buttonCount !== 1) throw new Error(buttonCount ? "Ambiguous sourceName" : "Source not found");
  let text = "";
  try {
    const selfError = await button.evaluate((el) => {
      if (!el.classList.contains("source-stretched-button")) return true;
      const row = el.closest(".single-source-container");
      return Boolean(
        row &&
        (row.classList.contains("single-source-error-container") ||
          row.querySelector('[aria-label="エラー情報"], .single-source-error-container, .error'))
      );
    });
    if (selfError) throw new Error(`NotebookLM source processing error: ${sourceName}`);
    // Keep the exact live role-bound locator, but bypass the aria-hidden title
    // overlay that intercepts Playwright's synthetic click in NotebookLM.
    await button.evaluate((el) => (el as HTMLElement).click());
    const viewer = page.locator("source-viewer");
    await viewer.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
    const elements = viewer.locator(".elements-container");
    await elements.waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) });
    const scroller = viewer.locator(".scroll-container");
    let lastText = "",
      lastHeight = -1,
      lastTop = -1,
      stable = 0;
    let polls = 0;
    while (Date.now() < deadline && polls++ < 80 && stable < 3) {
      await scroller.evaluate((el) => {
        (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
      });
      const next = await elements.innerText();
      if (!next.trim()) throw new Error("Empty source transcript");
      const metrics = await scroller.evaluate((el) => ({
        height: (el as HTMLElement).scrollHeight,
        top: (el as HTMLElement).scrollTop,
      }));
      if (next === lastText && metrics.height === lastHeight && metrics.top === lastTop)
        stable += 1;
      else {
        stable = 0;
        lastText = next;
        lastHeight = metrics.height;
        lastTop = metrics.top;
      }
      text = next;
      if (stable >= 3) settled = true;
      if (stable < 3) await new Promise((r) => setTimeout(r, 150));
    }
    if (!settled) {
      if (!text.trim())
        throw new Error(
          Date.now() >= deadline
            ? "Transcript extraction deadline reached"
            : "Transcript rendering did not settle"
        );
    }
  } finally {
    // Best effort: return to the notebook source list so subsequent exports see
    // the sidebar again. Restoration must never mask an extraction error.
    try {
      await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.locator(".single-source-container .source-title").first().waitFor({
        state: "visible",
        timeout: 10_000,
      });
    } catch {
      await page.keyboard?.press("Escape").catch(() => undefined);
    }
  }
  text = text.replace(/\r\n?/g, "\n").trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars).trimEnd();
  if (!text) throw new Error("Empty source transcript");
  return {
    text,
    chunks: [
      { index: 0, marker: truncated ? "MORE" : "COMPLETE", chars: text.length, sha256: hash(text) },
    ],
    completeness: truncated || !settled ? "partial" : "ui_extracted",
    warnings: [
      ...(truncated ? ["maxChars reached; transcript is partial"] : []),
      ...(!settled
        ? [
            Date.now() >= deadline
              ? "deadline reached; transcript may be partial"
              : "rendering settle limit reached; transcript may be partial",
          ]
        : []),
    ],
    provenance: {
      provider: "NotebookLM/Gemini",
      generatedByAI: null,
      transcriptOrigin: "unknown_notebooklm_rendered",
      verification: "ui_extracted_not_independently_verified",
      sourceIsolation: "direct_exact_title_click",
    },
    limitations: [
      "Transcript extracted directly from the NotebookLM source viewer; not verified against original media",
      "NotebookLM rendering may be delayed or lazy-loaded; extraction stops at bounded settle/deadline limits",
    ],
  };
}
function finiteInt(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isSafeInteger(v)
    ? Math.min(max, Math.max(min, v))
    : fallback;
}
function validSource(s: string): void {
  const hasControl = [...s].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (typeof s !== "string" || !s.trim() || s.length > 300 || hasControl)
    throw new Error("Invalid sourceName");
}
function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
export async function writeTranscript(
  result: TranscriptResult,
  privateDir: string,
  outputName: string,
  format: "markdown" | "json" = "markdown"
): Promise<WriteReceipt> {
  if (!/^[\w.-]+$/.test(outputName) || outputName === "." || outputName === "..")
    throw new Error("Unsafe outputName");
  const root = path.resolve(privateDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new Error("privateDir must be real directory");
  await fs.chmod(root, 0o700);
  const target = path.join(root, `${outputName}.${format === "json" ? "json" : "md"}`);
  try {
    const t = await fs.lstat(target);
    if (t.isSymbolicLink()) throw new Error("Refusing symlink");
  } catch (e: unknown) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
  const body = format === "json" ? JSON.stringify(result) + "\n" : buildMarkdownReceipt(result);
  const tmp = path.join(root, `.${randomBytes(12).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, body, { flag: "wx", mode: 0o600 });
    await fs.link(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  const data = Buffer.from(body);
  return { path: target, format, bytes: data.length, sha256: hash(body) };
}

function buildMarkdownReceipt(result: TranscriptResult): string {
  const runs = [...result.text.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = "`".repeat(Math.max(3, (runs.length ? Math.max(...runs) : 0) + 1));
  return `# NotebookLM source-viewer transcript (UI-extracted)\n\nCompleteness: ${result.completeness}\n\nProvenance:\n- provider: ${result.provenance.provider}\n- source isolation: ${result.provenance.sourceIsolation}\n- transcript origin: ${result.provenance.transcriptOrigin}\n- generated by AI: ${result.provenance.generatedByAI ?? "unknown"}\n- verification: ${result.provenance.verification}\n\nWarnings:\n${result.warnings.length ? result.warnings.map((w) => `- ${w}`).join("\n") : "- none"}\n\nLimitations:\n${result.limitations.map((w) => `- ${w}`).join("\n")}\n\n${fence}text\n${result.text}\n${fence}\n`;
}
