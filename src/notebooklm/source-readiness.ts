import type { Page } from "patchright";
import { safeSleep } from "../browser/watchdog.js";

export type SourceReadinessStatus = "ready" | "processing" | "error" | "not_found" | "timeout";

export interface SourceReadinessItem {
  name: string;
  status: SourceReadinessStatus;
  evidence: string[];
}

export interface SourceReadinessResult {
  status: SourceReadinessStatus;
  overall: "ready" | "processing" | "error" | "not_found" | "timeout";
  sources: SourceReadinessItem[];
  limitation: string;
}

const LIMITATION = "UI readiness only; this does not verify transcript completeness.";
const normalize = (value: string): string => value.normalize("NFKC").trim().toLowerCase();

export type RowSnapshot = {
  name: string;
  text: string;
  busy: boolean;
  error: boolean;
  readyEvidence?: boolean;
};

function validateNames(names?: string[]): string[] {
  if (!names || names.length < 1 || names.length > 10)
    throw new Error("sourceNames must contain 1..10 names");
  const out = names.map((name) => {
    if (
      !name ||
      name.length > 300 ||
      [...name].some((char) => {
        const code = char.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    )
      throw new Error("Invalid source name");
    return name;
  });
  if (new Set(out.map(normalize)).size !== out.length)
    throw new Error("sourceNames must be unique");
  return out;
}

export function classifySourceRows(
  rows: RowSnapshot[],
  requested?: string[]
): SourceReadinessItem[] {
  const targets = requested?.map((name) => ({ raw: name, key: normalize(name) }));
  if (!targets?.length) {
    return rows.map((row) => ({
      name: row.name,
      status: row.error ? "error" : row.busy || !row.readyEvidence ? "processing" : "ready",
      evidence: evidenceFor(row),
    }));
  }
  return targets.map(({ raw, key }) => {
    const row = rows.find((candidate) => normalize(candidate.name) === key);
    if (!row)
      return { name: raw, status: "not_found", evidence: ["No exact visible source-name match"] };
    return {
      name: row.name,
      status: row.error ? "error" : row.busy || !row.readyEvidence ? "processing" : "ready",
      evidence: evidenceFor(row),
    };
  });
}

function evidenceFor(row: RowSnapshot): string[] {
  const evidence: string[] = [];
  if (row.busy) evidence.push("Busy/progress indicator or processing label detected");
  if (row.error) evidence.push("Row-local error indicator detected");
  if (!evidence.length)
    evidence.push("Exact visible source row present without busy/error indicators");
  return evidence;
}

async function snapshotRows(page: Page): Promise<RowSnapshot[]> {
  const locator = page.locator(".single-source-container");
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const text = (element.textContent ?? "").trim();
      const descendants = Array.from(
        element.querySelectorAll("[data-source-title], [aria-label], [title], .source-title")
      );
      const visible = (node: Element) => {
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const names = descendants
        .filter(visible)
        .map((node) => (node.textContent ?? "").trim())
        .filter(Boolean);
      const title = element.querySelector(".source-title, [data-source-title]");
      const name = (title && (title.textContent ?? "").trim()) || names[0] || text;
      const lower = text.normalize("NFKC").toLowerCase();
      const busy =
        Boolean(
          element.querySelector(
            '[role="progressbar"], [aria-busy="true"], .spinner, mat-progress-spinner'
          )
        ) || /processing|uploading|indexing|pending|処理中|解析中/.test(lower);
      const error =
        Boolean(
          element.querySelector(
            '[role="alert"], .error, .mat-error, [aria-invalid="true"], .single-source-error-container, [aria-label="エラー情報"]'
          )
        ) || /error|failed|失敗|エラー/.test(lower);
      const controls = Array.from(
        element.querySelectorAll('input[type="checkbox"], [role="checkbox"]')
      ) as Element[];
      const readyEvidence =
        controls.some((control) => !(control as HTMLInputElement).disabled) ||
        Boolean(element.querySelector('[data-ready="true"], .source-ready')) ||
        Array.from(element.querySelectorAll("button.source-stretched-button")).some((button) => {
          const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
          // Keep this callback self-contained: Playwright serializes it into the
          // page and cannot resolve module-scope helpers or closures.
          const key = (value: string) => value.normalize("NFKC").trim().toLowerCase();
          return key(label) === key(name) && !(button as HTMLButtonElement).disabled;
        });
      return { name, text, busy, error, readyEvidence };
    })
  );
}

export async function inspectSourceReadiness(
  page: Page,
  options: { sourceNames?: string[] } = {}
): Promise<SourceReadinessResult> {
  const names = validateNames(options.sourceNames);
  const items = classifySourceRows(await snapshotRows(page), names);
  const overall = items.some((item) => item.status === "error")
    ? "error"
    : items.some((item) => item.status === "not_found")
      ? "not_found"
      : items.some((item) => item.status === "processing")
        ? "processing"
        : "ready";
  return { status: overall, overall, sources: items, limitation: LIMITATION };
}

export async function waitForSourceReady(
  page: Page,
  options: {
    sourceNames?: string[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    stablePolls?: number;
  } = {}
): Promise<SourceReadinessResult> {
  const names = validateNames(options.sourceNames);
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 90_000, 10 * 60_000));
  const pollIntervalMs = Math.max(50, Math.min(options.pollIntervalMs ?? 1_000, 30_000));
  const stablePolls = Math.max(1, Math.min(options.stablePolls ?? 2, 20));
  const started = Date.now();
  let stable = 0;
  let latest = await inspectSourceReadiness(page, { ...options, sourceNames: names });
  while (Date.now() - started <= timeoutMs) {
    if (latest.overall === "error") return latest;
    if (latest.overall === "ready") {
      stable += 1;
      if (stable >= stablePolls) return latest;
    } else stable = 0;
    await safeSleep(page, pollIntervalMs);
    latest = await inspectSourceReadiness(page, { ...options, sourceNames: names });
  }
  return { ...latest, status: "timeout", overall: "timeout", limitation: LIMITATION };
}

export async function withExclusiveSourceSelection<T>(
  page: Page,
  sourceName: string,
  operation: () => Promise<T>
): Promise<T> {
  validateNames([sourceName]);
  const rows = page.locator(".single-source-container");
  const matches = await rows.evaluateAll(
    (elements, wanted) =>
      elements.reduce<number[]>((acc, element, index) => {
        const title =
          element.querySelector("[data-source-title], [title], .source-title")?.textContent ?? "";
        if (
          title.normalize("NFKC").trim().toLowerCase() ===
          String(wanted).normalize("NFKC").trim().toLowerCase()
        )
          acc.push(index);
        return acc;
      }, [] as number[]),
    sourceName
  );
  if (matches.length !== 1) throw new Error("Exact source row not found");
  const target = rows.nth(matches[0]);
  const controls = page.locator(
    '.single-source-container input[type="checkbox"], .single-source-container [role="checkbox"]'
  );
  const states = await controls.evaluateAll((els) =>
    els.map((el) => ({
      checked: (el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true",
      disabled: (el as HTMLInputElement).disabled,
    }))
  );
  if (!states.length || states.some((state) => state.disabled))
    throw new Error("Source selection controls unavailable or disabled");
  try {
    await controls.evaluateAll(
      (els, name) =>
        els.forEach((el) => {
          const row = el.closest(".single-source-container");
          const title = row
            ?.querySelector("[data-source-title], [title], .source-title")
            ?.textContent?.trim();
          const on =
            title?.normalize("NFKC").trim().toLowerCase() ===
            String(name).normalize("NFKC").trim().toLowerCase();
          const current =
            (el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true";
          if (current !== on) (el as HTMLElement).click();
        }),
      sourceName
    );
    const selected = await target
      .locator('input[type="checkbox"], [role="checkbox"]')
      .evaluateAll((els) =>
        els.some(
          (el) => (el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true"
        )
      );
    if (!selected) throw new Error("Target source selection failed");
    return await operation();
  } finally {
    let restoreError: Error | undefined;
    try {
      await controls.evaluateAll(
        (els, saved) =>
          els.forEach((el, i) => {
            const state = (saved as { checked: boolean }[])[i];
            const current =
              (el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true";
            if (state && current !== state.checked) (el as HTMLElement).click();
          }),
        states
      );
      const restored = await controls.evaluateAll(
        (els, saved) =>
          els.every(
            (el, i) =>
              ((el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true") ===
              (saved as { checked: boolean }[])[i]?.checked
          ),
        states
      );
      if (!restored) restoreError = new Error("Failed to restore source selection state");
    } catch (error) {
      restoreError = error instanceof Error ? error : new Error(String(error));
    }
    if (restoreError) {
      // eslint-disable-next-line no-unsafe-finally -- restoration failure must be surfaced
      throw restoreError;
    }
  }
}
