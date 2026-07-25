import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const read = (path) => readFile(resolve(root, path), "utf8");
const files = {
  ci: await read(".github/workflows/ci.yml"),
  watch: await read(".github/workflows/upstream-watch.yml"),
  prepare: await read(".github/workflows/prepare-upstream-pr.yml"),
  release: await read(".github/workflows/release-gate.yml"),
};
const packageJson = JSON.parse(await read("package.json"));
const trustedVerifier = await read("scripts/verify-trusted-releases.mjs");

const forbiddenEverywhere = [
  /pull_request_target/, /workflow_run:/, /repository_dispatch:/,
  /permissions:\s*write-all/, /id-token:\s*write/, /\bsecrets\./,
  /--force(?:\s|$)/, /gh\s+release\b/, /gh\s+pr\s+merge\b/,
];
for (const [name, content] of Object.entries(files)) {
  for (const pattern of forbiddenEverywhere) {
    assert.doesNotMatch(content, pattern, `${name} contains forbidden ${pattern}`);
  }
  for (const line of content.split("\n").filter((line) => line.includes("uses:"))) {
    assert.match(line, /@[0-9a-f]{40}(?:\s|$)/, `${name} action is not pinned to a full SHA: ${line.trim()}`);
  }
}

assert.match(files.ci, /pull_request:/);
assert.match(files.ci, /push:/);
assert.match(files.ci, /contents:\s*read/);
assert.match(files.ci, /fetch-depth:\s*0/);
assert.match(files.ci, /npm ci --ignore-scripts/);
assert.match(files.ci, /npm run check/);
assert.match(files.ci, /npm test/);

assert.match(files.watch, /schedule:/);
assert.match(files.watch, /workflow_dispatch:/);
assert.match(files.watch, /contents:\s*read/);
assert.match(files.watch, /git ls-remote --refs/);
for (const forbidden of [/actions\/checkout/, /git fetch/, /git clone/, /npm\s/, /\bgh\s/, /git push/]) {
  assert.doesNotMatch(files.watch, forbidden, `watch must remain read-only: ${forbidden}`);
}

assert.match(files.prepare, /workflow_dispatch:/);
assert.match(files.prepare, /contents:\s*write/);
assert.match(files.prepare, /pull-requests:\s*write/);
assert.match(files.prepare, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
assert.match(files.prepare, /\^\[0-9a-f\]\{40\}\$/);
assert.match(files.prepare, /git ls-remote/);
assert.match(files.prepare, /git fetch --no-tags/);
assert.match(files.prepare, /gh pr create/);
assert.doesNotMatch(files.prepare, /npm\s/);

assert.match(files.release, /workflow_dispatch:/);
assert.match(files.release, /contents:\s*read/);
assert.match(files.release, /fetch-depth:\s*0/);
assert.match(files.release, /npm ci --ignore-scripts/);
assert.match(files.release, /npm test/);
assert.match(files.release, /sha:\n\s+description: "Exact lowercase 40-character commit SHA/);
assert.match(files.release, /RELEASE_SHA: \$\{\{ inputs\.sha \}\}/);
assert.match(files.release, /\^\[0-9a-f\]\{40\}\$/);
assert.match(files.release, /git rev-parse HEAD/);
assert.match(files.release, /refs\/tags\/\$RELEASE_REF\^\{\}/);
assert.match(files.release, /node scripts\/verify-trusted-releases\.mjs/);
assert.match(files.release, /--origin origin/);
assert.doesNotMatch(files.release, /--skip-(?:origin|upstream|remote)-tags/);
assert.match(trustedVerifier, /CANONICAL_UPSTREAM_REPOSITORY = "https:\/\/github\.com\/PleasePrompto\/notebooklm-mcp\.git"/);
assert.match(trustedVerifier, /verifyUpstreamTags\(manifest, repo, options\.upstreamUrl\)/);

for (const script of [
  "test:workflow-security",
  "test:lineage",
  "test:tool-compatibility",
  "test:trusted-releases",
  "test:installer",
]) {
  assert.ok(packageJson.scripts[script], `missing mandatory package script: ${script}`);
  assert.match(packageJson.scripts.test, new RegExp(`npm run ${script}`), `npm test does not run ${script}`);
}

console.log("workflow security tests: PASS");
