import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import { countSources } from "./sources.js";
import { safeSleep } from "../browser/watchdog.js";

export interface AddYouTubeSourceInput {
  url: string;
  timeoutMs?: number;
}
export interface AddYouTubeSourceResult {
  success: boolean;
  status: "CONFIRMED" | "INDETERMINATE" | "FAILED";
  url: string;
  sourceCountBefore: number;
  sourceCountAfter: number;
  /** Canonical source titles suitable for wait_for_source_ready/export_transcript. */
  sourceNames: string[];
  verifiedSourceRows: string[];
  identityConfidence: "exact" | "exact-dom-video-id" | "unique-new-row" | "none";
  message?: string;
}

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const TRACKING_PARAMS = new Set(["si", "t", "feature", "list", "index", "start", "pp"]);

export function validateYouTubeUrl(value: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("url must be a non-empty string.");
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Invalid YouTube URL.");
  }
  if (value.trim().length > 2048) throw new Error("YouTube URL exceeds the 2048 character limit.");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port)
    throw new Error("YouTube URL must use https without credentials or a port.");
  const host = parsed.hostname.toLowerCase();
  if (!HOSTS.has(host)) throw new Error("URL host is not an allowed YouTube host.");
  let id: string;
  if (host === "youtu.be") {
    if (
      !/^\/[A-Za-z0-9_-]{11}\/?$/.test(parsed.pathname) ||
      [...parsed.searchParams.keys()].some((k) => !TRACKING_PARAMS.has(k)) ||
      parsed.hash
    )
      throw new Error("Invalid youtu.be video URL.");
    id = parsed.pathname.split("/")[1];
  } else if (parsed.pathname === "/watch") {
    const keys = [...parsed.searchParams.keys()];
    if (
      keys.some((k) => k !== "v" && !TRACKING_PARAMS.has(k)) ||
      parsed.searchParams.getAll("v").length !== 1 ||
      parsed.hash
    )
      throw new Error("Invalid YouTube watch URL.");
    const value = parsed.searchParams.get("v");
    if (!value) throw new Error("YouTube watch URL is missing a video ID.");
    id = value;
  } else if (
    /^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(parsed.pathname) &&
    [...parsed.searchParams.keys()].every((k) => TRACKING_PARAMS.has(k)) &&
    !parsed.hash
  ) {
    id = parsed.pathname.split("/")[2];
    return `https://www.youtube.com/shorts/${id}`;
  } else throw new Error("URL must be a YouTube watch or shorts video URL.");
  if (!id || !ID.test(id)) throw new Error("Invalid YouTube video ID.");
  return `https://www.youtube.com/watch?v=${id}`;
}

export async function addYouTubeSource(
  page: Page,
  input: AddYouTubeSourceInput
): Promise<AddYouTubeSourceResult> {
  let canonical: string;
  try {
    canonical = validateYouTubeUrl(input.url);
  } catch (error) {
    return {
      success: false,
      status: "FAILED",
      url: input.url,
      sourceCountBefore: 0,
      sourceCountAfter: 0,
      sourceNames: [],
      verifiedSourceRows: [],
      identityConfidence: "none",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const timeout = input.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 1_200_000)
    return {
      success: false,
      status: "FAILED",
      url: canonical,
      sourceCountBefore: 0,
      sourceCountAfter: 0,
      sourceNames: [],
      verifiedSourceRows: [],
      identityConfidence: "none",
      message: "timeoutMs must be an integer between 1000 and 1200000.",
    };
  let before: number;
  let beforeRows: string[];
  try {
    before = await countSources(page);
    beforeRows = await sourceRows(page);
  } catch (error) {
    return {
      success: false,
      status: "FAILED",
      url: canonical,
      sourceCountBefore: 0,
      sourceCountAfter: 0,
      sourceNames: [],
      verifiedSourceRows: [],
      identityConfidence: "none",
      message: `Unable to snapshot sources before submit: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let submitted = false;
  try {
    const overlay = page.locator(Selectors.sources.overlayPane).first();
    if (!(await overlay.isVisible({ timeout: 500 }).catch(() => false))) {
      await page.locator(Selectors.sources.addButton.join(", ")).first().click({ timeout: 5_000 });
      await overlay.waitFor({ state: "visible", timeout: 10_000 });
    }
    let chosen = false;
    for (const selector of Selectors.sources.sourceTypeYoutube) {
      const candidate = overlay.locator(selector).first();
      if (await candidate.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await candidate.click();
        chosen = true;
        break;
      }
    }
    if (!chosen) throw new Error("YouTube source button not found.");
    let field = page.locator(Selectors.sources.youtubeUrlTextarea.join(", ")).first();
    if (!(await field.isVisible({ timeout: 1_000 }).catch(() => false))) {
      field = page.locator(Selectors.sources.overlayTextarea).first();
    }
    await field.waitFor({ state: "visible", timeout: 5_000 });
    await field.fill(canonical);
    const fieldDialog = field.locator('xpath=ancestor::*[@role="dialog"][1]');
    const submit = (await fieldDialog.count().catch(() => 0))
      ? fieldDialog.locator(Selectors.sources.insertConfirm.join(", ")).first()
      : overlay.locator(Selectors.sources.insertConfirm.join(", ")).first();
    submitted = true;
    await submit.click({ timeout: 5_000 });
    await overlay.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => undefined);
    const deadline = Date.now() + timeout;
    let after = before;
    let lastTitle = "";
    let stablePolls = 0;
    while (Date.now() < deadline) {
      after = await countSources(page).catch(() => before);
      const rows = await sourceRows(page);
      const fresh = rows.filter((row) => !beforeRows.includes(row));
      const exact = fresh.filter((row) => row.includes(canonical.split("v=")[1] ?? ""));
      // NotebookLM's row text contains controls (e.g. `more_vert`) and is
      // not a stable source identity. Only canonical `.source-title` values
      // may be returned to the readiness/transcript tools.
      const candidate = exact.length === 1 ? exact[0] : fresh.length === 1 ? fresh[0] : "";
      const displayTitle = candidate && !isUrlPlaceholder(candidate) ? candidate : "";
      if (displayTitle && displayTitle === lastTitle) stablePolls += 1;
      else if (displayTitle) {
        lastTitle = displayTitle;
        stablePolls = 1;
      } else {
        lastTitle = "";
        stablePolls = 0;
      }
      // NotebookLM first inserts a URL placeholder and asynchronously swaps
      // it for the display title. Do not hand the placeholder downstream.
      if (after > before && displayTitle && stablePolls >= 3) {
        const verified = await verifyYoutubeIdentity(
          page,
          displayTitle,
          canonical,
          Math.min(15_000, deadline - Date.now())
        );
        if (!verified)
          return {
            success: false,
            status: "INDETERMINATE",
            url: canonical,
            sourceCountBefore: before,
            sourceCountAfter: after,
            sourceNames: [],
            verifiedSourceRows: [],
            identityConfidence: "none",
            message:
              "Source title did not verify against the hydrated YouTube video identity; do not automatically retry.",
          };
        return {
          success: true,
          status: "CONFIRMED",
          url: canonical,
          sourceCountBefore: before,
          sourceCountAfter: after,
          sourceNames: [displayTitle],
          verifiedSourceRows: [displayTitle],
          identityConfidence: "exact-dom-video-id",
        };
      }
      await safeSleep(page, 300);
    }
    return {
      success: false,
      status: "INDETERMINATE",
      url: canonical,
      sourceCountBefore: before,
      sourceCountAfter: after,
      sourceNames: [],
      verifiedSourceRows: [],
      identityConfidence: "none",
      message: "Source title did not become a stable display title; do not automatically retry.",
    };
  } catch (error) {
    return {
      success: false,
      status: submitted ? "INDETERMINATE" : "FAILED",
      url: canonical,
      sourceCountBefore: before,
      sourceCountAfter: await countSources(page).catch(() => before),
      sourceNames: [],
      verifiedSourceRows: [],
      identityConfidence: "none",
      message: `${error instanceof Error ? error.message : String(error)}${submitted ? " Upload may have started; do not automatically retry." : ""}`,
    };
  }
}

async function verifyYoutubeIdentity(
  page: Page,
  title: string,
  canonical: string,
  timeoutMs: number
): Promise<boolean> {
  const id = new URL(canonical).searchParams.get("v") || canonical.split("/").pop() || "";
  const original = page.url();
  try {
    const button = page.getByRole("button", { name: title, exact: true });
    if ((await button.count()) !== 1) return false;
    // Overlay layers can intercept Playwright's click; invoke the exact DOM
    // element's click after proving there is a single exact-match button.
    await button.evaluate((element) => (element as HTMLElement).click());
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      const viewer = page.locator("source-viewer");
      const iframe = viewer.locator('iframe[src*="youtube-nocookie.com/embed/"]');
      if ((await iframe.count().catch(() => 0)) === 1) {
        const src = await iframe
          .first()
          .getAttribute("src")
          .catch(() => null);
        const parsed = src ? new URL(src, "https://notebooklm.google.com") : null;
        const pathId = parsed?.pathname.match(/\/embed\/([A-Za-z0-9_-]{11})/)?.[1];
        const titleEl = viewer.locator("#source-title[title]");
        const hydratedTitle = await titleEl.getAttribute("title").catch(() => null);
        if (pathId === id && hydratedTitle === title) return true;
      }
      await safeSleep(page, 250);
    }
    return false;
  } finally {
    await page
      .goto(original, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => undefined);
  }
}

function isUrlPlaceholder(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function sourceRows(page: Page): Promise<string[]> {
  return page.locator(Selectors.sources.sourceContainer).evaluateAll((elements) =>
    elements
      .map((element) => {
        const title = element.querySelector<HTMLElement>(".source-title");
        return (title?.getAttribute("aria-label") || title?.textContent || "")
          .normalize("NFKC")
          .trim();
      })
      .filter(Boolean)
  );
}
