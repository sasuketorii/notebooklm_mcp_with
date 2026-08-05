import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BrowserSession } from "../dist/session/browser-session.js";
import { CONFIG } from "../dist/config.js";
import {
  formatQueryInputDiagnostics,
  locateVisibleQueryInput,
  recoverVisibleQueryInput,
} from "../dist/notebooklm/query-input.js";
import { Selectors } from "../dist/notebooklm/selectors.js";

const NOTEBOOK_ID = "12345678-1234-1234-1234-123456789012";
const NOTEBOOK_URL = `https://notebook.google.com/notebook/${NOTEBOOK_ID}`;

function fakePage({
  visibleSelector = null,
  visibleAt = 0,
  overlay = false,
  url = NOTEBOOK_URL,
  showAfterNavigation = false,
} = {}) {
  let clock = 0;
  let currentUrl = url;
  let overlayOpen = overlay;
  let selected = visibleSelector;
  const events = [];
  const isVisible = (selector) => selected === selector && clock >= visibleAt && !overlayOpen;
  const page = {
    events,
    now: () => clock,
    url: () => currentUrl,
    keyboard: {
      async press(key) {
        events.push(`key:${key}`);
        if (key === "Escape") overlayOpen = false;
      },
    },
    locator(selector) {
      return {
        first() {
          return this;
        },
        async isVisible() {
          return isVisible(selector);
        },
        async count() {
          if (selector === '[role="dialog"]:visible') return overlayOpen ? 1 : 0;
          return isVisible(selector) ? 1 : 0;
        },
      };
    },
    async waitForSelector(selectorList, options) {
      events.push("wait:query");
      const selectors = selectorList.split(", ");
      const candidateCanAppear = selected && selectors.includes(selected) && !overlayOpen;
      if (candidateCanAppear && visibleAt <= clock + options.timeout) {
        clock = Math.max(clock, visibleAt);
        return {};
      }
      clock += options.timeout;
      throw new Error("fixture timeout");
    },
    async goto(nextUrl) {
      events.push("goto");
      currentUrl = nextUrl;
      if (showAfterNavigation) {
        selected = visibleSelector;
        overlayOpen = false;
      }
      return null;
    },
    async evaluate(fn) {
      if (String(fn).includes("document.readyState")) return "complete";
      return {
        authentication: false,
        consent: false,
        accessDenied: false,
        loading: false,
      };
    },
    isClosed() {
      return false;
    },
  };
  return page;
}

// Every centrally registered selector is accepted by the exact same probe.
for (const selector of Selectors.chat.queryInput) {
  const page = fakePage({ visibleSelector: selector });
  assert.equal(await locateVisibleQueryInput(page), selector);
  const recovered = await recoverVisibleQueryInput(page, {
    expectedNotebookUrl: NOTEBOOK_URL,
    timeoutMs: 30_000,
    now: page.now,
  });
  assert.equal(recovered.selector, selector);
}

assert.ok(
  !Selectors.chat.queryInput.includes('textarea[aria-label="Feld für Anfragen"]'),
  "readiness must not depend on one exact German label"
);
assert.ok(
  Selectors.chat.queryInput.every((selector) => selector.startsWith("textarea")),
  "do not add an unverified contenteditable selector without live DOM evidence"
);

// A composer appearing at 16 s is accepted within the 30 s browser budget,
// without the old 10 s + 5 s cutoff or an eager reload.
{
  const selector = Selectors.chat.queryInput.at(-1);
  const page = fakePage({ visibleSelector: selector, visibleAt: 16_000 });
  const result = await recoverVisibleQueryInput(page, {
    expectedNotebookUrl: NOTEBOOK_URL,
    timeoutMs: 30_000,
    now: page.now,
  });
  assert.equal(result.selector, selector);
  assert.equal(page.now(), 16_000);
  assert.ok(!page.events.includes("goto"), "delayed hydration must not trigger an eager reload");
}

// Blocking overlays are dismissed before readiness is declared.
{
  const selector = Selectors.chat.queryInput[0];
  const page = fakePage({ visibleSelector: selector, overlay: true });
  const result = await recoverVisibleQueryInput(page, {
    expectedNotebookUrl: NOTEBOOK_URL,
    timeoutMs: 30_000,
    now: page.now,
  });
  assert.equal(result.selector, selector);
  assert.deepEqual(page.events.slice(0, 2), ["key:Escape", "key:Escape"]);
}

// Only addSource is removed; unrelated query state and notebook identity survive.
{
  const selector = Selectors.chat.queryInput[0];
  const page = fakePage({
    visibleSelector: selector,
    visibleAt: 0,
    overlay: true,
    url: `${NOTEBOOK_URL}?foo=bar&addSource=true`,
    showAfterNavigation: true,
  });
  // Keep the candidate hidden after Escape so URL cleanup is exercised.
  page.keyboard.press = async (key) => page.events.push(`key:${key}`);
  const result = await recoverVisibleQueryInput(page, {
    expectedNotebookUrl: NOTEBOOK_URL,
    timeoutMs: 30_000,
    now: page.now,
  });
  assert.equal(result.selector, selector);
  const cleaned = new URL(page.url());
  assert.equal(cleaned.searchParams.get("foo"), "bar");
  assert.equal(cleaned.searchParams.has("addSource"), false);
  assert.equal(cleaned.pathname, `/notebook/${NOTEBOOK_ID}`);
}

// Requested notebook identity is fail-closed before recovery or navigation.
{
  const other = fakePage({
    visibleSelector: Selectors.chat.queryInput[0],
    url: "https://notebook.google.com/notebook/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
  await assert.rejects(
    () =>
      recoverVisibleQueryInput(other, {
        expectedNotebookUrl: NOTEBOOK_URL,
        timeoutMs: 30_000,
        now: other.now,
      }),
    /does not match the requested notebook/
  );
  assert.equal(other.events.length, 0);
}

// Identity divergence caused by stale-URL cleanup is rejected before another
// probe or recovery action can run.
{
  const page = fakePage({ url: `${NOTEBOOK_URL}?addSource=true`, overlay: true });
  page.keyboard.press = async (key) => page.events.push(`key:${key}`);
  page.goto = async () => {
    page.events.push("goto:cleanup-diverged");
    page.url = () => "https://notebook.google.com/notebook/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  };
  await assert.rejects(
    () =>
      recoverVisibleQueryInput(page, {
        expectedNotebookUrl: NOTEBOOK_URL,
        timeoutMs: 30_000,
        now: page.now,
      }),
    /does not match the requested notebook/
  );
  assert.equal(page.events.filter((event) => event.startsWith("goto")).length, 1);
}

// Identity divergence caused by the final reload is equally fail-closed.
{
  const page = fakePage();
  page.goto = async () => {
    page.events.push("goto:reload-diverged");
    page.url = () => "https://notebook.google.com/notebook/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  };
  await assert.rejects(
    () =>
      recoverVisibleQueryInput(page, {
        expectedNotebookUrl: NOTEBOOK_URL,
        timeoutMs: 30_000,
        now: page.now,
      }),
    /does not match the requested notebook/
  );
  assert.ok(page.events.includes("wait:query"));
  assert.equal(page.events.filter((event) => event.startsWith("goto")).length, 1);
}

// Failure diagnostics are structured and contain neither URLs, IDs, nor paths.
{
  const page = fakePage();
  const result = await recoverVisibleQueryInput(page, {
    expectedNotebookUrl: NOTEBOOK_URL,
    timeoutMs: 1,
    reload: false,
    now: page.now,
  });
  const diagnostics = formatQueryInputDiagnostics(result.diagnostics);
  assert.equal(result.selector, null);
  assert.doesNotMatch(diagnostics, /https?:|12345678|\/Users\//);
  assert.equal(result.diagnostics.notebookIdentityMatched, true);
  assert.equal(result.diagnostics.selectorCandidateCounts.length, Selectors.chat.queryInput.length);
}

// Even a stale historical readiness flag for the same notebook cannot bypass
// current overlay / addSource recovery. Failure remains before filechooser.
{
  const page = fakePage({ url: `${NOTEBOOK_URL}?addSource=true`, overlay: true });
  page.keyboard.press = async (key) => page.events.push(`key:${key}`);
  let fileChooserCalls = 0;
  page.waitForEvent = async (event) => {
    if (event === "filechooser") fileChooserCalls += 1;
    throw new Error("filechooser must not be reached");
  };
  const contextManager = { invalidateRuntimeVerification() {} };
  const authManager = {};
  const session = new BrowserSession("readiness-policy", contextManager, authManager, NOTEBOOK_URL);
  Object.assign(session, {
    page,
    initialized: true,
    readinessVerified: true,
  });
  const previousTimeout = CONFIG.browserTimeout;
  CONFIG.browserTimeout = 1;
  try {
    await assert.rejects(
      () => session.addAudioSource({ filePaths: ["/not-an-upload.mp3"] }),
      /query composer was not visible/
    );
  } finally {
    CONFIG.browserTimeout = previousTimeout;
  }
  assert.equal(fileChooserCalls, 0);
  assert.deepEqual(page.events.slice(0, 2), ["key:Escape", "key:Escape"]);
  assert.ok(page.events.filter((event) => event === "goto").length >= 1);
}

const browserSessionSource = await readFile(
  new URL("../src/session/browser-session.ts", import.meta.url),
  "utf8"
);
const queryInputSource = await readFile(
  new URL("../src/notebooklm/query-input.ts", import.meta.url),
  "utf8"
);
assert.doesNotMatch(browserSessionSource, /Feld für Anfragen/);
assert.match(
  browserSessionSource,
  /addAudioSource[\s\S]*await this\.ensureMutationReadyUnlocked\(\);[\s\S]*addAudioSourceToPage/
);
assert.doesNotMatch(queryInputSource, /headless|CONFIG\.headless/);

console.log("query input readiness tests passed");
