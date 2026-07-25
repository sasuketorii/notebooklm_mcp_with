import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG, ensureDirectories } from "../dist/config.js";
import { AuthManager } from "../dist/auth/auth-manager.js";
import { ToolHandlers } from "../dist/tools/handlers.js";
import { systemTools } from "../dist/tools/definitions/system.js";

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
  await writeFile(path.join(profileDir, "SingletonLock"), "stale-marker");

  let performCount = 0;
  let sessionCloseCount = 0;
  const fakeAuthManager = {
    async performSetup() {
      performCount += 1;
      return true;
    },
    async hasExternalProfileLock() {
      throw new Error("existence-only Singleton precheck must not run");
    },
  };
  const fakeSessionManager = {
    async closeAllSessions() {
      sessionCloseCount += 1;
    },
  };
  const handlers = new ToolHandlers(fakeSessionManager, fakeAuthManager, {});

  try {
    const setupResult = await handlers.handleSetupAuth({ show_browser: false });
    assert.equal(setupResult.success, true);
    assert.equal(performCount, 1);
    await access(stateFile);
    await access(profileSentinel);

    const reAuthResult = await handlers.handleReAuth({ show_browser: false });
    assert.equal(reAuthResult.success, false);
    assert.match(reAuthResult.error, /re_auth_unavailable/);
    assert.equal(performCount, 1, "fail-closed re_auth must not launch a browser");
    assert.equal(sessionCloseCount, 0, "fail-closed re_auth must not close sessions");
    await access(stateFile);
    await access(profileSentinel);
    assert.equal(await readFile(stateFile, "utf8"), "existing-state");
    assert.equal(await readFile(profileSentinel, "utf8"), "existing-profile");

    const busyHandlers = new ToolHandlers(
      fakeSessionManager,
      {
        async performSetup() {
          throw new Error("profile_busy");
        },
      },
      {}
    );
    const busyResult = await busyHandlers.handleSetupAuth({ show_browser: false });
    assert.equal(busyResult.success, false);
    assert.equal(busyResult.error, "profile_busy");

    let cleanupFactoryCount = 0;
    let cleanupPreviewCount = 0;
    const cleanupHandlers = new ToolHandlers(
      fakeSessionManager,
      fakeAuthManager,
      {},
      {
        cleanupManagerFactory: () => {
          cleanupFactoryCount += 1;
          return {
            async getCleanupPaths(_mode, preserveLibrary) {
              cleanupPreviewCount += 1;
              const paths = preserveLibrary
                ? ["/hypothetical/cache"]
                : ["/hypothetical/library.json", "/hypothetical/cache"];
              return {
                categories: [
                  {
                    name: "test",
                    description: "hypothetical",
                    paths,
                    totalBytes: paths.length,
                    optional: false,
                  },
                ],
                totalPaths: paths,
                totalSizeBytes: paths.length,
              };
            },
            getPlatformInfo() {
              return { platform: "test" };
            },
            formatBytes(bytes) {
              return `${bytes} B`;
            },
          };
        },
      }
    );
    const configBeforeCleanup = { ...CONFIG };
    const deniedCleanup = await cleanupHandlers.handleCleanupData({
      confirm: true,
      preserve_library: false,
    });
    assert.equal(deniedCleanup.success, false);
    assert.match(deniedCleanup.error, /cleanup_unavailable/);
    assert.equal(cleanupFactoryCount, 0, "confirm=true must return before filesystem preview");
    const fullPreview = await cleanupHandlers.handleCleanupData({
      confirm: false,
      preserve_library: false,
    });
    const preservedPreview = await cleanupHandlers.handleCleanupData({
      confirm: false,
      preserve_library: true,
    });
    assert.equal(fullPreview.data.preview.totalPaths, 2);
    assert.equal(preservedPreview.data.preview.totalPaths, 1);
    assert.equal(cleanupFactoryCount, 2);
    assert.equal(cleanupPreviewCount, 2);
    assert.deepEqual(CONFIG, configBeforeCleanup);
    assert.equal(sessionCloseCount, 0);
    assert.equal(performCount, 1, "cleanup preview must not launch a browser");
    assert.equal(await readFile(stateFile, "utf8"), "existing-state");
    assert.equal(await readFile(profileSentinel, "utf8"), "existing-profile");

    const reAuthDefinition = systemTools.find((tool) => tool.name === "re_auth");
    const cleanupDefinition = systemTools.find((tool) => tool.name === "cleanup_data");
    assert.match(
      reAuthDefinition.inputSchema.properties.show_browser.description,
      /Accepted but ignored/
    );
    assert.match(
      reAuthDefinition.inputSchema.properties.browser_options.description,
      /Accepted but ignored/
    );
    assert.equal(cleanupDefinition.annotations.title, "Preview cleanup paths");
    assert.match(
      cleanupDefinition.inputSchema.properties.preserve_library.description,
      /excludes library-related paths/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log("auth permission and fail-closed re-auth preservation tests passed");
