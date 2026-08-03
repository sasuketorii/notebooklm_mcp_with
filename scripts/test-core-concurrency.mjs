import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG } from "../dist/config.js";
import { SessionManager } from "../dist/session/session-manager.js";
import { BrowserSession, shouldReuseInitializedPage } from "../dist/session/browser-session.js";
import { ToolHandlers, withTemporaryBrowserConfig } from "../dist/tools/handlers.js";
import { SERVER_NAME, SERVER_VERSION } from "../dist/version.js";
import { SettingsManager } from "../dist/utils/settings-manager.js";

const originalTimeout = CONFIG.browserTimeout;
const observations = [];
await Promise.all([
  withTemporaryBrowserConfig({ timeout_ms: 111_111 }, undefined, async () => {
    observations.push(CONFIG.browserTimeout);
    await delay(30);
    observations.push(CONFIG.browserTimeout);
  }),
  withTemporaryBrowserConfig({ timeout_ms: 222_222 }, undefined, async () => {
    observations.push(CONFIG.browserTimeout);
    await delay(5);
    observations.push(CONFIG.browserTimeout);
  }),
]);
assert.deepEqual(observations, [111_111, 111_111, 222_222, 222_222]);
assert.equal(CONFIG.browserTimeout, originalTimeout);

let releaseOverride;
let overrideEntered;
const overrideEnteredPromise = new Promise((resolve) => {
  overrideEntered = resolve;
});
const overrideGate = new Promise((resolve) => {
  releaseOverride = resolve;
});
let browserOperationStarted = false;
let browserOperationObservedTimeout;
const isolationHandlers = new ToolHandlers(
  {
    getOrCreateSession: async () => {
      browserOperationStarted = true;
      browserOperationObservedTimeout = CONFIG.browserTimeout;
      return { addSource: async () => ({ success: true }) };
    },
  },
  {},
  {}
);
const heldOverride = withTemporaryBrowserConfig({ timeout_ms: 333_333 }, undefined, async () => {
  overrideEntered();
  await overrideGate;
});
await overrideEnteredPromise;
const isolatedBrowserCall = isolationHandlers.handleAddSource({
  type: "text",
  content: "serialization proof",
  notebook_url: "https://notebooklm.google.com/notebook/12345678-1234-1234-1234-123456789012",
});
await delay(10);
assert.equal(browserOperationStarted, false, "browser operation must wait for CONFIG restoration");
releaseOverride();
await Promise.all([heldOverride, isolatedBrowserCall]);
assert.equal(browserOperationObservedTimeout, originalTimeout);
const priorProfile = process.env.NOTEBOOKLM_PROFILE;
process.env.NOTEBOOKLM_PROFILE = "standard";
try {
  const filtered = new SettingsManager().filterTools([
    { name: "close_session" },
    { name: "disabled-in-standard" },
  ]);
  assert.deepEqual(
    filtered.map((tool) => tool.name),
    ["close_session"]
  );
} finally {
  if (priorProfile === undefined) delete process.env.NOTEBOOKLM_PROFILE;
  else process.env.NOTEBOOKLM_PROFILE = priorProfile;
}
assert.equal(shouldReuseInitializedPage(true, false), true);
assert.equal(shouldReuseInitializedPage(true, true), false);

let disposedContextOpens = 0;
const disposedSession = new BrowserSession(
  "disposed",
  {
    getOrCreateContext: async () => {
      disposedContextOpens += 1;
      throw new Error("must not reopen");
    },
  },
  {},
  "https://notebooklm.google.com/notebook/12345678-1234-1234-1234-123456789012"
);
await disposedSession.close();
await assert.rejects(() => disposedSession.init(), /closed and cannot be reopened/);
await assert.rejects(
  () => disposedSession.addSource({ type: "text", content: "must not run" }),
  /closed and cannot be reopened/
);
assert.equal(disposedContextOpens, 0);

let contextCreates = 0;
let sessionCreates = 0;
let initCalls = 0;
const fakeContext = {
  needsHeadlessModeChange: () => false,
  getOrCreateContext: async () => {
    contextCreates += 1;
    await delay(15);
  },
  closeContext: async () => undefined,
};
const makeSession = (sessionId, _context, _auth, notebookUrl) => {
  sessionCreates += 1;
  return {
    sessionId,
    notebookUrl,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    init: async () => {
      initCalls += 1;
      await delay(15);
    },
    updateActivity: () => undefined,
    close: async () => undefined,
  };
};
const manager = new SessionManager(
  {},
  { sharedContextManager: fakeContext, createSession: makeSession }
);
const notebookUrl = "https://notebooklm.google.com/notebook/12345678-1234-1234-1234-123456789012";
const [first, second] = await Promise.all([
  manager.getOrCreateSession("same", notebookUrl),
  manager.getOrCreateSession("same", notebookUrl),
]);
assert.equal(first, second);
assert.equal(contextCreates, 1);
assert.equal(sessionCreates, 1);
assert.equal(initCalls, 1);
const sameNotebookDifferentHost = await manager.getOrCreateSession(
  "same",
  "https://notebook.google.com/notebook/12345678-1234-1234-1234-123456789012?authuser=1"
);
assert.equal(sameNotebookDifferentHost, first);
assert.equal(sessionCreates, 1);
const differentNotebook = await manager.getOrCreateSession(
  "same",
  "https://notebook.google.com/notebook/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
);
assert.notEqual(differentNotebook, first);
assert.equal(sessionCreates, 2);
await manager.closeAllSessions();

let lifecycleActive = 0;
let maxLifecycleActive = 0;
const serialContext = {
  needsHeadlessModeChange: () => false,
  getOrCreateContext: async () => {
    lifecycleActive += 1;
    maxLifecycleActive = Math.max(maxLifecycleActive, lifecycleActive);
    await delay(20);
    lifecycleActive -= 1;
  },
  closeContext: async () => undefined,
};
const serialManager = new SessionManager(
  {},
  { sharedContextManager: serialContext, createSession: makeSession }
);
await Promise.all([
  serialManager.getOrCreateSession("one", notebookUrl),
  serialManager.getOrCreateSession("two", notebookUrl),
]);
assert.equal(maxLifecycleActive, 1, "different session ids must serialize browser creation");
serialContext.needsHeadlessModeChange = () => true;
await assert.rejects(
  () => serialManager.getOrCreateSession("three", notebookUrl, true),
  /visibility while sessions are active/
);
await serialManager.closeAllSessions();

let slowInitFinished = false;
const slowManager = new SessionManager(
  {},
  {
    sharedContextManager: fakeContext,
    createSession: (id, context, auth, url) => {
      const session = makeSession(id, context, auth, url);
      session.init = async () => {
        await delay(30);
        slowInitFinished = true;
      };
      return session;
    },
  }
);
const pendingCreate = slowManager.getOrCreateSession("pending", notebookUrl);
const pendingClose = slowManager.closeAllSessions();
await Promise.all([pendingCreate, pendingClose]);
assert.equal(slowInitFinished, true);
assert.equal(slowManager.getSession("pending"), null, "closeAll must run after pending creation");

let failFirst = true;
const retryManager = new SessionManager(
  {},
  {
    sharedContextManager: fakeContext,
    createSession: (id, context, auth, url) => {
      const session = makeSession(id, context, auth, url);
      session.init = async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("expected init failure");
        }
      };
      return session;
    },
  }
);
await assert.rejects(() => retryManager.getOrCreateSession("retry", notebookUrl));
assert.equal((await retryManager.getOrCreateSession("retry", notebookUrl)).sessionId, "retry");
await retryManager.closeAllSessions();

const raceSessions = [];
const raceManager = new SessionManager(
  {},
  {
    sharedContextManager: fakeContext,
    createSession: (id, _context, _auth, url) => {
      const session = {
        sessionId: id,
        notebookUrl: url,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
        closed: false,
        init: async () => undefined,
        updateActivity: () => undefined,
        close: async () => {
          await delay(20);
          session.closed = true;
        },
      };
      raceSessions.push(session);
      return session;
    },
  }
);
const oldSession = await raceManager.getOrCreateSession("race", notebookUrl);
const closeRace = raceManager.closeSession("race");
const replacementPromise = raceManager.getOrCreateSession("race", notebookUrl);
const [, replacement] = await Promise.all([closeRace, replacementPromise]);
assert.equal(oldSession.closed, true);
assert.notEqual(replacement, oldSession);
assert.equal(replacement.closed, false);
assert.equal(raceManager.getSession("race"), replacement);
await raceManager.closeAllSessions();

const failedCloseManager = new SessionManager(
  {},
  {
    sharedContextManager: fakeContext,
    createSession: (id, _context, _auth, url) => ({
      sessionId: id,
      notebookUrl: url,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      init: async () => undefined,
      updateActivity: () => undefined,
      close: async () => {
        throw new Error("expected close failure");
      },
    }),
  }
);
await failedCloseManager.getOrCreateSession("close-fails", notebookUrl);
await assert.rejects(() => failedCloseManager.closeSession("close-fails"));
assert.equal(failedCloseManager.getSession("close-fails"), null);

const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
assert.equal(SERVER_NAME, packageMetadata.name);
assert.equal(SERVER_VERSION, packageMetadata.version);
console.log("CONFIG isolation, session creation dedupe, and provenance tests passed");
