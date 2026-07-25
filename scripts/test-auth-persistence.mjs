import assert from "node:assert/strict";
import { mkdtemp, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  BaseProfileLease,
  BaseProfileLeaseHandle,
  classifyAuthHealth,
  inspectStorageState,
  inspectSnapshotFile,
  readSecureJson,
  writeSecureJson,
} from "../dist/auth/auth-persistence.js";
import { ToolHandlers } from "../dist/tools/handlers.js";
import {
  SharedContextManager,
  decideProfileMode,
  shouldPublishRecoverySnapshot,
} from "../dist/session/shared-context-manager.js";
import { CONFIG } from "../dist/config.js";
import { isChannelFailure, isProfileLockError } from "../dist/browser/chromium-fallback.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "notebooklm-auth-test-"));
const configSnapshot = { ...CONFIG };
const realProfilePaths = [
  CONFIG.browserStateDir,
  CONFIG.chromeProfileDir,
  CONFIG.chromeInstancesDir,
];
Object.assign(CONFIG, {
  browserStateDir: path.join(dir, "browser-state"),
  chromeProfileDir: path.join(dir, "chrome-profile"),
  chromeInstancesDir: path.join(dir, "chrome-instances"),
  cleanupInstancesOnStartup: false,
  cleanupInstancesOnShutdown: false,
});
assert.ok(
  [CONFIG.browserStateDir, CONFIG.chromeProfileDir, CONFIG.chromeInstancesDir].every(
    (candidate) =>
      candidate.startsWith(`${dir}${path.sep}`) && !realProfilePaths.includes(candidate)
  ),
  "auth persistence tests must redirect every profile path before manager construction"
);
try {
  const statePath = path.join(dir, "state.json");
  const now = Date.now() / 1000;
  const cookie = (overrides = {}) => ({
    name: "SID",
    value: "test-value-not-a-real-cookie",
    domain: ".google.com",
    path: "/",
    expires: now + 60,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...overrides,
  });
  const state = (cookies, origins = []) => ({ cookies, origins });

  // A 28 hour old snapshot is still usable when its cookie evidence is live.
  await writeSecureJson(statePath, state([cookie()]));
  await utimes(
    statePath,
    new Date(Date.now() - 28 * 3600_000),
    new Date(Date.now() - 28 * 3600_000)
  );
  assert.equal((await inspectSnapshotFile(statePath)).usable, true);

  // Session-only evidence is allowed for isolated bootstrap, but health cannot
  // turn it into a durable authenticated verdict.
  const sessionOnly = inspectStorageState(state([cookie({ expires: -1 })]));
  assert.equal(sessionOnly.usable, false);
  assert.equal(sessionOnly.bootstrapEligible, true);
  assert.equal(sessionOnly.evidence, "session_only");

  assert.equal(
    inspectStorageState(state([cookie({ domain: "google.com.evil.example" })])).bootstrapEligible,
    false
  );
  assert.equal(inspectStorageState(state([cookie({ expires: now - 1 }), cookie()])).usable, true);
  assert.equal(inspectStorageState(state([cookie({ expires: "never" })])).bootstrapEligible, false);
  assert.equal(inspectStorageState({ cookies: [cookie()] }).reason, "invalid_storage_state");
  assert.equal(
    inspectStorageState({ ...state([cookie()]), unexpected: true }).reason,
    "invalid_storage_state"
  );
  assert.equal(
    inspectStorageState(state([{ ...cookie(), httpOnly: "yes" }])).reason,
    "snapshot_malformed_or_unsafe"
  );
  assert.equal(
    inspectStorageState(state([{ ...cookie(), sameSite: "Default" }])).reason,
    "snapshot_malformed_or_unsafe"
  );
  assert.equal(
    inspectStorageState(state([{ ...cookie({ name: "NON_CRITICAL" }), secure: undefined }])).reason,
    "snapshot_malformed_or_unsafe"
  );
  assert.equal(
    inspectStorageState(state([{ ...cookie(), value: undefined }])).reason,
    "snapshot_malformed_or_unsafe"
  );
  assert.equal(
    inspectStorageState(state([{ ...cookie(), path: undefined }])).reason,
    "snapshot_malformed_or_unsafe"
  );
  assert.equal(
    inspectStorageState(
      state([cookie()], [{ origin: "https://notebooklm.google.com", localStorage: [] }])
    ).usable,
    true
  );
  assert.equal(
    inspectStorageState(state([cookie()], [{ origin: "file:///unsafe", localStorage: [] }]))
      .bootstrapEligible,
    false
  );
  assert.equal(
    inspectStorageState(
      state([cookie()], [{ origin: "https://notebooklm.google.com/path", localStorage: [] }])
    ).reason,
    "snapshot_malformed_or_unsafe"
  );
  assert.notEqual(
    inspectStorageState(state(Array.from({ length: 512 }, () => cookie()))).evidence,
    "invalid"
  );
  assert.equal(
    inspectStorageState(state(Array.from({ length: 513 }, () => cookie()))).reason,
    "invalid_storage_state"
  );
  const validOrigin = { origin: "https://notebooklm.google.com", localStorage: [] };
  assert.notEqual(
    inspectStorageState(
      state(
        [cookie()],
        Array.from({ length: 64 }, () => validOrigin)
      )
    ).evidence,
    "invalid"
  );
  assert.equal(
    inspectStorageState(
      state(
        [cookie()],
        Array.from({ length: 65 }, () => validOrigin)
      )
    ).reason,
    "invalid_storage_state"
  );
  assert.notEqual(
    inspectStorageState(state([cookie({ value: "x".repeat(8192) })])).evidence,
    "invalid"
  );
  assert.equal(
    inspectStorageState(state([cookie({ value: "x".repeat(8193) })])).reason,
    "snapshot_malformed_or_unsafe"
  );
  assert.notEqual(
    inspectStorageState(
      state(
        [cookie()],
        [
          {
            ...validOrigin,
            localStorage: Array.from({ length: 256 }, (_, i) => ({
              name: String(i),
              value: "v",
            })),
          },
        ]
      )
    ).evidence,
    "invalid"
  );
  assert.equal(
    inspectStorageState(
      state(
        [cookie()],
        [
          {
            ...validOrigin,
            localStorage: Array.from({ length: 257 }, (_, i) => ({
              name: String(i),
              value: "v",
            })),
          },
        ]
      )
    ).reason,
    "snapshot_malformed_or_unsafe"
  );

  // Symlinks are rejected, and a second process-local lease cannot steal a live
  // owner. (The implementation separately verifies pid start identity on stale
  // cross-process records.)
  const link = path.join(dir, "link.json");
  await symlink(statePath, link);
  await assert.rejects(readSecureJson(link));
  const first = new BaseProfileLease(dir);
  const second = new BaseProfileLease(dir);
  const firstHandle = await first.acquire("runtime");
  assert.ok(firstHandle);
  assert.equal(await second.acquire("setup_auth"), null);
  await Promise.all([firstHandle.release(), firstHandle.release()]);

  let fakeReleaseCount = 0;
  let lossFinished = false;
  const fakeOwner = {
    async heartbeat() {
      return false;
    },
    async release() {
      fakeReleaseCount++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
  const idempotentHandle = new BaseProfileLeaseHandle(fakeOwner, "token", "generation", "runtime");
  idempotentHandle.onLost(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    lossFinished = true;
  });
  assert.equal(await idempotentHandle.heartbeat(), false);
  assert.equal(lossFinished, true, "heartbeat awaits asynchronous loss teardown");
  const releaseOne = idempotentHandle.release();
  const releaseTwo = idempotentHandle.release();
  assert.equal(releaseOne, releaseTwo, "release returns the retained promise");
  await Promise.all([releaseOne, releaseTwo]);
  assert.equal(fakeReleaseCount, 1);

  // Real child-process contention: a separate Node process sees a live owner
  // and cannot acquire/release its token.
  const held = await new BaseProfileLease(dir).acquire("runtime");
  assert.ok(held);
  const moduleUrl = new URL("../dist/auth/auth-persistence.js", import.meta.url).href;
  const child = await new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { BaseProfileLease } from '${moduleUrl}'; const l=new BaseProfileLease(${JSON.stringify(dir)}); console.log((await l.acquire('setup_auth')) ? 'acquired' : 'busy');`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    p.stdout.on("data", (chunk) => {
      output += chunk;
    });
    p.on("exit", (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error(`child ${code}`))
    );
  });
  assert.equal(child, "busy");
  await held.release();

  // Direct proper-lockfile crash: after SIGKILL and stale timeout, two real
  // children race for BaseProfileLease. Exactly one owns it and a third is busy.
  const crashDir = await mkdtemp(path.join(os.tmpdir(), "notebooklm-auth-crash-"));
  const lockModuleUrl = new URL("../node_modules/proper-lockfile/index.js", import.meta.url).href;
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import lockfile from '${lockModuleUrl}'; await lockfile.lock(${JSON.stringify(crashDir)},{stale:2000,update:1000,retries:0}); console.log('held'); setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NOTEBOOK_LEASE_STALE_MS: "50" } }
  );
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", (chunk) =>
      String(chunk).includes("held") ? resolve() : reject(new Error("holder did not acquire"))
    );
    holder.once("error", reject);
  });
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  // proper-lockfile probes filesystem mtime precision and can round the lock
  // timestamp forward. Allow more than two full stale windows to avoid a
  // platform-dependent boundary race.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const contenderCode = `import { BaseProfileLease } from '${moduleUrl}'; const l=new BaseProfileLease(${JSON.stringify(crashDir)}); const h=await l.acquire('runtime'); console.log(h?'acquired':'busy'); if(h)setInterval(()=>{},1000);`;
  const contenders = [0, 1].map(() =>
    spawn(process.execPath, ["--input-type=module", "-e", contenderCode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NOTEBOOK_LEASE_STALE_MS: "50" },
    })
  );
  const contenderResults = await Promise.all(
    contenders.map(
      (p) =>
        new Promise((resolve, reject) => {
          p.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
          p.once("error", reject);
        })
    )
  );
  assert.equal(contenderResults.filter((v) => v === "acquired").length, 1);
  assert.equal(contenderResults.filter((v) => v === "busy").length, 1);
  const winner = contenders[contenderResults.findIndex((v) => v === "acquired")];
  const third = await new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { BaseProfileLease } from '${moduleUrl}'; const l=new BaseProfileLease(${JSON.stringify(crashDir)}); console.log((await l.acquire('setup_auth'))?'acquired':'busy');`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NOTEBOOK_LEASE_STALE_MS: "50" } }
    );
    let output = "";
    p.stdout.on("data", (chunk) => (output += chunk));
    p.once("exit", (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error(`child ${code}`))
    );
  });
  assert.equal(third, "busy");
  winner.kill("SIGKILL");

  // A stale dead owner is atomically quarantined before reclaim. A live pid with
  // a mismatched identity models PID reuse and is likewise reclaimable only when
  // its heartbeat is stale.
  const leasePath = path.join(dir, "base-profile.lease.json");
  await writeSecureJson(leasePath, {
    token: "dead-token",
    pid: 99999999,
    identity: "linux:old:1",
    mode: "runtime",
    heartbeat: Date.now() - 31_000,
    createdAt: 0,
  });
  const reclaimed = await new BaseProfileLease(dir).acquire("runtime");
  assert.ok(reclaimed);
  await reclaimed.release();
  await writeSecureJson(leasePath, {
    token: "reused-token",
    pid: process.pid,
    identity: "definitely-not-current",
    mode: "runtime",
    heartbeat: Date.now() - 31_000,
    createdAt: 0,
  });
  const reused = await new BaseProfileLease(dir).acquire("runtime");
  assert.ok(reused);
  await reused.release();

  // Health consumes only cached runtime/snapshot facts. This fake deliberately
  // has no browser methods; a browser/network/lease call would throw.
  const healthAuth = {
    async inspectSnapshot() {
      return {
        usable: false,
        bootstrapEligible: true,
        evidence: "session_only",
        criticalPersistent: 0,
        criticalSessionOnly: 1,
        invalidCritical: 0,
        reason: "session_only_critical_cookie",
      };
    },
  };
  const healthSessions = {
    isRuntimeVerified: () => false,
    getStats: () => ({
      active_sessions: 0,
      max_sessions: 1,
      session_timeout: 1,
      total_messages: 0,
    }),
  };
  const healthLibrary = {
    getActiveNotebook: () => null,
    getStats: () => ({ total_notebooks: 0 }),
  };
  const health = await new ToolHandlers(
    healthSessions,
    healthAuth,
    healthLibrary
  ).handleGetHealth();
  assert.equal(health.success, true);
  assert.equal(health.data.authenticated, false);
  assert.equal(health.data.auth_status, "snapshot_indeterminate");

  // Exact health contract table. Only live readiness and durable persistent
  // snapshot evidence set authenticated=true.
  const inspection = (overrides) => ({
    usable: false,
    bootstrapEligible: false,
    evidence: "none",
    criticalPersistent: 0,
    criticalSessionOnly: 0,
    invalidCritical: 0,
    reason: "no_google_critical_cookie",
    ...overrides,
  });
  const healthTable = [
    [true, inspection({}), "runtime_verified", true, "live_notebooklm_readiness"],
    [
      false,
      inspection({ usable: true, bootstrapEligible: true, reason: "persistent_critical_cookie" }),
      "snapshot_usable",
      true,
      "persistent_critical_cookie",
    ],
    [
      false,
      inspection({ bootstrapEligible: true, reason: "session_only_critical_cookie" }),
      "snapshot_indeterminate",
      false,
      "session_only_critical_cookie",
    ],
    [
      false,
      inspection({ reason: "snapshot_missing" }),
      "snapshot_missing",
      false,
      "snapshot_missing",
    ],
    [
      false,
      inspection({ evidence: "invalid", reason: "snapshot_malformed_or_unsafe" }),
      "snapshot_malformed",
      false,
      "snapshot_malformed_or_unsafe",
    ],
    [
      false,
      inspection({ evidence: "invalid", invalidCritical: 1, reason: "snapshot_expired" }),
      "snapshot_expired",
      false,
      "snapshot_expired",
    ],
    [
      false,
      inspection({ reason: "no_google_critical_cookie" }),
      "not_authenticated",
      false,
      "no_google_critical_cookie",
    ],
  ];
  for (const [runtime, snapshot, status, authenticated, evidence] of healthTable) {
    assert.deepEqual(classifyAuthHealth(snapshot, runtime), {
      authenticated,
      auth_status: status,
      auth_evidence: evidence,
    });
  }

  // Strategy policy and non-publication from isolated contexts.
  assert.equal(decideProfileMode("auto", true, false), "base");
  assert.equal(decideProfileMode("auto", false, true), "isolated");
  assert.equal(decideProfileMode("auto", false, false), "busy");
  assert.equal(decideProfileMode("single", false, true), "busy");
  assert.equal(decideProfileMode("isolated", true, true), "isolated");
  assert.equal(decideProfileMode("isolated", false, false), "busy");
  assert.equal(shouldPublishRecoverySnapshot(false, true, true), true);
  assert.equal(shouldPublishRecoverySnapshot(true, true, true), false);
  assert.equal(shouldPublishRecoverySnapshot(false, false, true), false);
  const combinedLockError = new Error(
    "Failed to launch chrome: ProcessSingleton user data directory is already in use"
  );
  assert.equal(isChannelFailure(combinedLockError), true);
  assert.equal(isProfileLockError(combinedLockError), true);
  assert.equal(isProfileLockError(new Error("SingletonLock marker exists")), true);
  assert.equal(isProfileLockError(new Error("Failed to launch chrome: executable missing")), false);

  let isolatedOwnsCount = 0;
  let isolatedSaveCount = 0;
  const isolatedManager = new SharedContextManager({
    async ownsBaseProfileLease() {
      isolatedOwnsCount++;
      return true;
    },
    async saveBrowserState() {
      isolatedSaveCount++;
      return true;
    },
  });
  isolatedManager.globalContext = {};
  isolatedManager.contextGenerationId = "isolated-generation";
  isolatedManager.isIsolatedProfile = true;
  await isolatedManager.markRuntimeVerified();
  assert.equal(isolatedManager.isRuntimeVerified(), true);
  assert.deepEqual([isolatedOwnsCount, isolatedSaveCount], [0, 0]);

  let baseOwnsCount = 0;
  let baseSaveCount = 0;
  const baseManager = new SharedContextManager({
    async ownsBaseProfileLease() {
      baseOwnsCount++;
      return true;
    },
    async saveBrowserState() {
      baseSaveCount++;
      return true;
    },
  });
  baseManager.globalContext = {};
  baseManager.contextGenerationId = "base-generation";
  baseManager.isIsolatedProfile = false;
  baseManager.baseLease = {};
  await baseManager.markRuntimeVerified();
  assert.equal(baseManager.isRuntimeVerified(), true);
  assert.deepEqual([baseOwnsCount, baseSaveCount], [2, 1]);

  // Generation-scoped teardown: concurrent close, a synchronous close event,
  // close failure, and validity failure all converge on one awaited release.
  const makeLifecycle = ({ closeThrows = false, cookiesThrow = false, emitClose = true } = {}) => {
    const manager = new SharedContextManager({});
    let closeCount = 0;
    let releaseCount = 0;
    const listeners = new Map();
    const context = {
      on(event, listener) {
        listeners.set(event, listener);
      },
      async cookies() {
        if (cookiesThrow) throw new Error("closed");
        return [];
      },
      async close() {
        closeCount++;
        if (emitClose) listeners.get("close")?.();
        if (closeThrows) throw new Error("close failed");
      },
    };
    const releasePromise = Promise.resolve().then(() => {
      releaseCount++;
    });
    const lease = { release: () => releasePromise };
    manager.globalContext = context;
    manager.contextCreatedAt = Date.now();
    manager.contextGenerationId = "generation-test";
    manager.currentHeadlessMode = true;
    manager.currentProfileDir = "/tmp/notebooklm-test-base";
    manager.baseLease = lease;
    manager.attachCloseListener(context, "generation-test");
    return {
      manager,
      context,
      triggerClose: () => listeners.get("close")?.(),
      counts: () => ({ closeCount, releaseCount }),
    };
  };
  for (const closeThrows of [false, true]) {
    const fixture = makeLifecycle({ closeThrows });
    await Promise.all([fixture.manager.closeContext(), fixture.manager.closeContext()]);
    assert.deepEqual(fixture.counts(), { closeCount: 1, releaseCount: 1 });
  }
  const noEventFixture = makeLifecycle({ emitClose: false });
  await noEventFixture.manager.closeContext();
  assert.deepEqual(noEventFixture.counts(), { closeCount: 1, releaseCount: 1 });
  const invalidFixture = makeLifecycle({ cookiesThrow: true });
  assert.equal(await invalidFixture.manager.needsRecreation(), true);
  assert.deepEqual(invalidFixture.counts(), { closeCount: 1, releaseCount: 1 });
  const externalFixture = makeLifecycle();
  // Trigger the registered external-close listener without calling close().
  externalFixture.triggerClose();
  await externalFixture.manager.closeContext();
  assert.deepEqual(externalFixture.counts(), { closeCount: 0, releaseCount: 1 });

  console.log(
    "auth persistence checks passed: strict-schema, health-table, strategy-policy, generation-teardown, direct-lock-crash-race"
  );
} finally {
  Object.assign(CONFIG, configSnapshot);
}
