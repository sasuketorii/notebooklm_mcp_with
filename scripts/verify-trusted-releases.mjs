#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CANONICAL_CUSTOM_REPOSITORY = "https://github.com/sasuketorii/notebooklm_mcp_with.git";
const CANONICAL_UPSTREAM_REPOSITORY = "https://github.com/PleasePrompto/notebooklm-mcp.git";
const REQUIRED_FILES = {
  custom: ["package.json", "RELEASE_PROVENANCE.json", "scripts/mcp-launcher.sh"],
  // The upstream v2.0.0 tag tracks source, not dist/. The installer never executes
  // an upstream candidate: it only recognizes and removes a known registration.
  // Identity is therefore the public tag/commit plus its tracked source blobs;
  // untracked build artifacts must not become a trust material.
  upstream: ["package.json", "src/index.ts"],
};
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const options = parseArgs(process.argv.slice(2));
const manifestPath = resolve(options.manifest);
const repo = resolve(options.repo);
const stat = lstatSync(manifestPath);
if (!stat.isFile() || stat.isSymbolicLink()) fail("trusted release manifest must be a regular file");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  fail("trusted release manifest is not valid JSON");
}

validatePolicy(manifest, repo);
if (!options.skipOriginTags) verifyCustomOriginTags(manifest, repo, options.origin);
if (!options.skipUpstreamTags) verifyUpstreamTags(manifest, repo, options.upstreamUrl);
if (options.targetRef) validateTargetPolicy(manifest, options.targetRef, options.targetSha);
console.log("Trusted release policy verified");

function parseArgs(args) {
  const result = {
    repo: process.cwd(),
    manifest: "TRUSTED_RELEASES.json",
    origin: "origin",
    skipOriginTags: false,
    skipUpstreamTags: false,
    upstreamUrl: CANONICAL_UPSTREAM_REPOSITORY,
    targetRef: "",
    targetSha: "",
  };
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--repo": result.repo = requireValue(arg, args.shift()); break;
      case "--manifest": result.manifest = requireValue(arg, args.shift()); break;
      case "--origin": result.origin = requireValue(arg, args.shift()); break;
      case "--skip-origin-tags": result.skipOriginTags = true; break;
      case "--skip-upstream-tags": result.skipUpstreamTags = true; break;
      case "--skip-remote-tags":
        result.skipOriginTags = true;
        result.skipUpstreamTags = true;
        break;
      case "--test-upstream-url":
        if (process.env.NODE_ENV !== "test") fail("test upstream URL is only available to fixtures");
        result.upstreamUrl = requireValue(arg, args.shift());
        break;
      case "--target-ref": result.targetRef = requireValue(arg, args.shift()); break;
      case "--target-sha": result.targetSha = requireValue(arg, args.shift()); break;
      default: fail(`unknown argument: ${arg}`);
    }
  }
  if (Boolean(result.targetRef) !== Boolean(result.targetSha)) fail("target ref and SHA must be supplied together");
  if (result.targetRef && !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(result.targetRef)) fail("target ref must be an exact stable tag");
  if (result.targetSha && !SHA.test(result.targetSha)) fail("target SHA must be a lowercase 40-character SHA");
  return result;
}

function requireValue(name, value) {
  if (!value) fail(`${name} requires a value`);
  return value;
}

function validatePolicy(manifest, repo) {
  if (!isPlainObject(manifest)) fail("manifest must be an object");
  if (manifest.customRepository !== CANONICAL_CUSTOM_REPOSITORY) fail("custom repository is not canonical");
  if (!isPlainObject(manifest.customReleases)) fail("customReleases must be an object");
  if (!isPlainObject(manifest.upstreamReleases)) fail("upstreamReleases must be an object");
  if (Object.keys(manifest.customReleases).length === 0) fail("customReleases must preserve pinned history");
  if (Object.keys(manifest.upstreamReleases).length === 0) fail("upstreamReleases must preserve pinned history");

  validateReleaseCollection(manifest.customReleases, "custom", repo);
  validateReleaseCollection(manifest.upstreamReleases, "upstream", repo);
}

function validateReleaseCollection(collection, kind, repo) {
  const expected = REQUIRED_FILES[kind];
  for (const [version, release] of Object.entries(collection)) {
    if (!SEMVER.test(version)) fail(`${kind} release has invalid version: ${version}`);
    if (!isPlainObject(release) || !SHA.test(release.commit)) fail(`${kind} ${version} has invalid commit`);
    if (!isPlainObject(release.files)) fail(`${kind} ${version} files must be an object`);
    const paths = Object.keys(release.files).sort();
    if (JSON.stringify(paths) !== JSON.stringify([...expected].sort())) {
      fail(`${kind} ${version} must contain exactly: ${expected.join(", ")}`);
    }
    ensureCommit(repo, release.commit, `${kind} ${version}`);
    for (const path of expected) {
      if (!isSafeRelativePath(path)) fail(`${kind} ${version} contains unsafe path: ${path}`);
      const expectedDigest = release.files[path];
      if (typeof expectedDigest !== "string" || !DIGEST.test(expectedDigest)) {
        fail(`${kind} ${version} has invalid digest for ${path}`);
      }
      const bytes = gitBlob(repo, release.commit, path);
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (actualDigest !== expectedDigest) fail(`${kind} ${version} digest mismatch for ${path}`);
    }
  }
}

function isSafeRelativePath(path) {
  return typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function ensureCommit(repo, commit, label) {
  const result = git(repo, ["cat-file", "-e", `${commit}^{commit}`]);
  if (result.status !== 0) fail(`${label} commit is absent or not a commit`);
}

function gitBlob(repo, commit, path) {
  const result = git(repo, ["show", "--no-textconv", "--no-ext-diff", `${commit}:${path}`]);
  if (result.status !== 0) fail(`cannot read Git blob ${commit}:${path}`);
  return result.stdout;
}

function verifyCustomOriginTags(manifest, repo, origin) {
  if (!/^[A-Za-z0-9_.-]+$/.test(origin)) fail("origin name is unsafe");
  for (const [version, release] of Object.entries(manifest.customReleases)) {
    const tag = `v${version}`;
    const tagObject = lsRemote(repo, origin, `refs/tags/${tag}`, true);
    const peeled = lsRemote(repo, origin, `refs/tags/${tag}^{}`, false);
    const resolved = peeled || tagObject;
    if (resolved !== release.commit) fail(`origin tag does not match trusted policy: ${tag}`);
  }
}

function verifyUpstreamTags(manifest, repo, upstreamUrl) {
  for (const [version, release] of Object.entries(manifest.upstreamReleases)) {
    verifyRemoteTag(repo, upstreamUrl, `v${version}`, release.commit, "canonical upstream");
  }
}

function verifyRemoteTag(repo, remote, tag, expectedCommit, label) {
  const tagObject = lsRemote(repo, remote, `refs/tags/${tag}`, true, label);
  const peeled = lsRemote(repo, remote, `refs/tags/${tag}^{}`, false, label);
  const resolved = peeled || tagObject;
  if (resolved !== expectedCommit) fail(`${label} tag does not match trusted policy: ${tag}`);
}

function validateTargetPolicy(manifest, targetRef, targetSha) {
  const version = targetRef.slice(1);
  const trusted = manifest.customReleases[version];
  if (trusted) {
    if (trusted.commit !== targetSha) fail(`target release disagrees with trusted policy: ${targetRef}`);
    console.log(`Target release is already trusted: ${targetRef}`);
  } else {
    console.log(`Target release is not yet trusted: ${targetRef}; existing policy remains fully verified.`);
  }
}

function lsRemote(repo, remote, ref, refsOnly, label = "origin") {
  const args = ["ls-remote"];
  if (refsOnly) args.push("--refs");
  args.push(remote, ref);
  const result = git(repo, args);
  if (result.status !== 0) fail(`cannot resolve ${label} ref: ${ref}`);
  const line = result.stdout.toString("utf8").trim();
  if (!line) {
    if (refsOnly) fail(`${label} ref is absent: ${ref}`);
    return "";
  }
  const [sha] = line.split("\t", 1);
  if (!SHA.test(sha)) fail(`${label} returned invalid SHA for ${ref}`);
  return sha;
}

function git(repo, args) {
  return spawnSync("git", [
    "-C", repo,
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.fsmonitor=false",
    "--no-pager",
    ...args,
  ], {
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`Trusted release verification failed: ${message}`);
}
