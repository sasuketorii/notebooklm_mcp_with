import type { Page } from "patchright";
import { getNotebookLmId } from "./notebook-url.js";
import { joinAlt, Selectors } from "./selectors.js";

export interface QueryInputDiagnostics {
  notebookIdentityMatched: boolean;
  documentReadyState: string;
  visibleDialogCount: number;
  selectorCandidateCounts: number[];
  pageSignals: {
    authentication: boolean;
    consent: boolean;
    accessDenied: boolean;
    loading: boolean;
  };
}

export interface QueryInputRecoveryResult {
  selector: string | null;
  diagnostics: QueryInputDiagnostics;
}

interface QueryInputRecoveryOptions {
  expectedNotebookUrl: string;
  timeoutMs: number;
  reload?: boolean;
  now?: () => number;
}

function notebookIdentityMatches(currentUrl: string, expectedUrl: string): boolean {
  try {
    return getNotebookLmId(currentUrl) === getNotebookLmId(expectedUrl);
  } catch {
    return false;
  }
}

function assertNotebookIdentity(page: Page, expectedNotebookUrl: string): void {
  if (!notebookIdentityMatches(page.url(), expectedNotebookUrl)) {
    throw new Error("NotebookLM page does not match the requested notebook");
  }
}

/**
 * Non-blocking, locale-independent probe for the visible query composer.
 * Selectors.chat.queryInput is deliberately the only selector registry used.
 */
export async function locateVisibleQueryInput(page: Page): Promise<string | null> {
  for (const selector of Selectors.chat.queryInput) {
    try {
      if (await page.locator(selector).first().isVisible({ timeout: 0 })) return selector;
    } catch {
      // A selector probing failure must not hide candidates later in the registry.
    }
  }
  return null;
}

function cleanAddSourceState(currentUrl: string): string | null {
  try {
    const url = new URL(currentUrl);
    if (!url.searchParams.has("addSource")) return null;
    url.searchParams.delete("addSource");
    return url.toString();
  } catch {
    return null;
  }
}

async function waitForVisibleQueryInput(page: Page, timeoutMs: number): Promise<string | null> {
  if (timeoutMs <= 0) return locateVisibleQueryInput(page);
  await page
    .waitForSelector(joinAlt(Selectors.chat.queryInput), {
      state: "visible",
      timeout: timeoutMs,
    })
    .catch(() => undefined);
  return locateVisibleQueryInput(page);
}

export async function collectQueryInputDiagnostics(
  page: Page,
  expectedNotebookUrl: string
): Promise<QueryInputDiagnostics> {
  const selectorCandidateCounts: number[] = [];
  for (const selector of Selectors.chat.queryInput) {
    selectorCandidateCounts.push(
      await page
        .locator(selector)
        .count()
        .catch(() => 0)
    );
  }

  const documentReadyState = await page.evaluate(() => document.readyState).catch(() => "unknown");
  const visibleDialogCount = await page
    .locator('[role="dialog"]:visible')
    .count()
    .catch(() => 0);
  const pageSignals = await page
    .evaluate(() => {
      const text = (document.body?.innerText ?? "").toLocaleLowerCase();
      return {
        authentication: /sign in|log in|anmelden|connexion|iniciar sesi[oó]n|ログイン/.test(text),
        consent: /consent|zustimmen|accepter|aceptar|同意/.test(text),
        accessDenied:
          /access denied|request access|zugriff verweigert|acc[eè]s refus[eé]|アクセス権/.test(
            text
          ),
        loading: /loading|wird geladen|chargement|cargando|読み込み/.test(text),
      };
    })
    .catch(() => ({
      authentication: false,
      consent: false,
      accessDenied: false,
      loading: false,
    }));

  return {
    notebookIdentityMatched: notebookIdentityMatches(page.url(), expectedNotebookUrl),
    documentReadyState,
    visibleDialogCount,
    selectorCandidateCounts,
    pageSignals,
  };
}

/**
 * Performs one bounded recovery sequence. It never calls itself and never
 * exceeds the caller's overall timeout intentionally. Navigation errors are
 * tolerated only while the page remains bound to the requested notebook.
 */
export async function recoverVisibleQueryInput(
  page: Page,
  options: QueryInputRecoveryOptions
): Promise<QueryInputRecoveryResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(0, options.timeoutMs);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - now());

  assertNotebookIdentity(page, options.expectedNotebookUrl);
  let selector = await locateVisibleQueryInput(page);
  if (selector) {
    return {
      selector,
      diagnostics: await collectQueryInputDiagnostics(page, options.expectedNotebookUrl),
    };
  }

  // Dismiss a blocking dialog, citation panel, or stale source overlay once.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined);
  assertNotebookIdentity(page, options.expectedNotebookUrl);
  selector = await locateVisibleQueryInput(page);

  // Remove only the known stale source-dialog flag while preserving all other
  // query parameters. Never log either URL because it contains the notebook ID.
  if (!selector) {
    const cleanUrl = cleanAddSourceState(page.url());
    if (cleanUrl && remaining() > 0) {
      await page
        .goto(cleanUrl, {
          waitUntil: "domcontentloaded",
          timeout: remaining(),
        })
        .catch(() => undefined);
      assertNotebookIdentity(page, options.expectedNotebookUrl);
      selector = await locateVisibleQueryInput(page);
    }
  }

  // Leave the first two thirds of the budget to normal hydration. This keeps
  // delayed composers (including >15 s) from being reset by an eager reload.
  if (!selector && remaining() > 0) {
    const hydrationDeadline = startedAt + Math.floor((timeoutMs * 2) / 3);
    selector = await waitForVisibleQueryInput(
      page,
      Math.min(remaining(), hydrationDeadline - now())
    );
  }

  // A single reload is the final recovery action. It is bounded by the same
  // deadline and can be disabled by callers that only want a passive probe.
  if (!selector && options.reload !== false && remaining() > 0) {
    await page
      .goto(options.expectedNotebookUrl, {
        waitUntil: "domcontentloaded",
        timeout: remaining(),
      })
      .catch(() => undefined);
    assertNotebookIdentity(page, options.expectedNotebookUrl);
    selector = await locateVisibleQueryInput(page);
  }

  if (!selector && remaining() > 0) {
    selector = await waitForVisibleQueryInput(page, remaining());
  }

  return {
    selector,
    diagnostics: await collectQueryInputDiagnostics(page, options.expectedNotebookUrl),
  };
}

export function formatQueryInputDiagnostics(diagnostics: QueryInputDiagnostics): string {
  return JSON.stringify(diagnostics);
}
