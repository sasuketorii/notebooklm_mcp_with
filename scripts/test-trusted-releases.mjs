#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const validator = join(fileURLToPath(new URL(".", import.meta.url)), "verify-trusted-releases.mjs");
const temp = mkdtempSync(join(tmpdir(), "notebooklm-trusted-release-test-"));
try {
  setupRepo(temp);
  const manifest = makeManifest(temp);
  writeFileSync(join(temp, "TRUSTED_RELEASES.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  expectPass("valid policy", temp);

  git(temp, ["tag", "-a", "-f", "v2.0.0", "-m", "fixture upstream"]);
  const canonicalFixture = makeBareRemote(temp, "canonical-upstream.git");
  expectPass("matching annotated/lightweight upstream tag", temp, ["--skip-origin-tags", "--test-upstream-url", canonicalFixture]);
  writeFileSync(join(temp, "src", "index.ts"), "export default 'forked fixture';\n");
  git(temp, ["add", "src/index.ts"]);
  git(temp, ["commit", "-qm", "forked upstream"]);
  git(temp, ["tag", "-f", "v2.0.0"]);
  const arbitraryFork = makeBareRemote(temp, "arbitrary-fork.git");
  const upstreamMismatch = run(temp, ["--skip-origin-tags", "--test-upstream-url", arbitraryFork]);
  assert.notEqual(upstreamMismatch.status, 0, "arbitrary local fork tag must not pass upstream binding");
  assert.match(upstreamMismatch.stderr, /canonical upstream tag does not match trusted policy/);

  const unsafe = structuredClone(manifest);
  unsafe.customReleases["1.0.0"].files["../scripts/mcp-launcher.sh"] = unsafe.customReleases["1.0.0"].files["scripts/mcp-launcher.sh"];
  delete unsafe.customReleases["1.0.0"].files["scripts/mcp-launcher.sh"];
  expectFail("unsafe path", temp, unsafe, /must contain exactly/);

  const omitted = structuredClone(manifest);
  delete omitted.customReleases["1.0.0"].files["RELEASE_PROVENANCE.json"];
  expectFail("missing critical custom file", temp, omitted, /must contain exactly/);

  const extra = structuredClone(manifest);
  extra.upstreamReleases["2.0.0"].files["README.md"] = digest(Buffer.from("unused"));
  expectFail("extra upstream file", temp, extra, /must contain exactly/);

  const erasedHistory = structuredClone(manifest);
  erasedHistory.customReleases = {};
  expectFail("erased custom history", temp, erasedHistory, /preserve pinned history/);

  const mismatch = structuredClone(manifest);
  mismatch.customReleases["1.0.0"].files["package.json"] = "0".repeat(64);
  expectFail("historical blob digest mismatch", temp, mismatch, /digest mismatch/);

  const targetMismatch = run(temp, ["--target-ref", "v1.0.0", "--target-sha", "f".repeat(40)]);
  assert.notEqual(targetMismatch.status, 0, "trusted target SHA mismatch must fail");
  console.log("trusted release policy synthetic tests: PASS");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function setupRepo(repo) {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Trusted Release Test"]);
  git(repo, ["config", "user.email", "trusted@example.invalid"]);
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), "{\"name\":\"fixture\"}\n");
  writeFileSync(join(repo, "RELEASE_PROVENANCE.json"), "{\"fixture\":true}\n");
  writeFileSync(join(repo, "scripts", "mcp-launcher.sh"), "#!/bin/sh\necho fixture\n");
  writeFileSync(join(repo, "src", "index.ts"), "export default 'fixture';\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
}

function makeManifest(repo) {
  const commit = git(repo, ["rev-parse", "HEAD"]).stdout.toString("utf8").trim();
  const files = (paths) => Object.fromEntries(paths.map((path) => [path, digest(readFileSync(join(repo, path)))]));
  return {
    customRepository: "https://github.com/sasuketorii/notebooklm_mcp_with.git",
    customReleases: { "1.0.0": { commit, files: files(["package.json", "RELEASE_PROVENANCE.json", "scripts/mcp-launcher.sh"]) } },
    upstreamReleases: { "2.0.0": { commit, files: files(["package.json", "src/index.ts"]) } },
  };
}

function makeBareRemote(repo, name) {
  const remote = join(repo, name);
  const result = spawnSync("git", ["init", "--bare", "-q", remote], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  git(repo, ["push", "--quiet", remote, "HEAD:refs/heads/main", "refs/tags/v2.0.0"]);
  return remote;
}

function expectPass(label, repo) {
  const result = run(repo);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
}

function expectFail(label, repo, manifest, pattern) {
  writeFileSync(join(repo, "bad.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = run(repo, ["--manifest", join(repo, "bad.json")]);
  assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
  assert.match(result.stderr, pattern, `${label}: ${result.stderr}`);
}

function run(repo, extra = []) {
  const remotePolicyFlag = extra.includes("--test-upstream-url")
    ? "--skip-origin-tags"
    : "--skip-remote-tags";
  return spawnSync(process.execPath, [
    validator,
    "--repo", repo,
    "--manifest", join(repo, "TRUSTED_RELEASES.json"),
    remotePolicyFlag,
    ...extra,
  ], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: null });
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
  return result;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
