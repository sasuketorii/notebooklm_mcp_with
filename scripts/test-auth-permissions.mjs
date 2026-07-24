import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG, ensureDirectories } from "../dist/config.js";
import { AuthManager } from "../dist/auth/auth-manager.js";
import { ToolHandlers } from "../dist/tools/handlers.js";

if (process.platform !== "win32") {
  const root = await mkdtemp(path.join(os.tmpdir(), "notebooklm-permissions-"));
  const original = { ...CONFIG };
  try {
    Object.assign(CONFIG, {
      configDir: path.join(root, "config"),
      dataDir: path.join(root, "data"),
      browserStateDir: path.join(root, "data", "browser_state"),
      chromeProfileDir: path.join(root, "data", "chrome_profile"),
      chromeInstancesDir: path.join(root, "data", "chrome_profile_instances"),
    });
    await mkdir(CONFIG.browserStateDir, { recursive: true, mode: 0o755 });
    const stateFile = path.join(CONFIG.browserStateDir, "state.json");
    const sessionFile = path.join(CONFIG.browserStateDir, "session.json");
    await writeFile(stateFile, "{}", { mode: 0o644 });
    await writeFile(sessionFile, "{}", { mode: 0o644 });
    ensureDirectories();
    new AuthManager();
    for (const dir of [CONFIG.dataDir, CONFIG.browserStateDir, CONFIG.chromeProfileDir])
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const file of [stateFile, sessionFile])
      assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    Object.assign(CONFIG, original);
    await rm(root, { recursive: true, force: true });
  }
}

{
  const root = await mkdtemp(path.join(os.tmpdir(), "notebooklm-auth-semantics-"));
  const stateFile = path.join(root, "state.json");
  const profileDir = path.join(root, "chrome_profile");
  const profileSentinel = path.join(profileDir, "sentinel");
  await mkdir(profileDir, { recursive: true });
  await writeFile(stateFile, "existing-state");
  await writeFile(profileSentinel, "existing-profile");

  let clearCount = 0;
  let performCount = 0;
  const fakeAuthManager = {
    async clearAllAuthData() {
      clearCount += 1;
      await rm(stateFile, { force: true });
      await rm(profileDir, { recursive: true, force: true });
    },
    async performSetup() {
      performCount += 1;
      return true;
    },
  };
  const fakeSessionManager = {
    async closeAllSessions() {},
  };
  const handlers = new ToolHandlers(fakeSessionManager, fakeAuthManager, {});

  try {
    const setupResult = await handlers.handleSetupAuth({ show_browser: false });
    assert.equal(setupResult.success, true);
    assert.equal(clearCount, 0, "setup_auth must not clear existing authentication");
    assert.equal(performCount, 1);
    await access(stateFile);
    await access(profileSentinel);

    const reAuthResult = await handlers.handleReAuth({ show_browser: false });
    assert.equal(reAuthResult.success, true);
    assert.equal(clearCount, 1, "re_auth must clear authentication exactly once");
    assert.equal(performCount, 2);
    await assert.rejects(access(stateFile));
    await assert.rejects(access(profileSentinel));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log("auth permission and setup/re-auth preservation tests passed");
