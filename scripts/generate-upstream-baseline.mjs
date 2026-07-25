#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadToolContracts, sha256, stableJson } from "./tool-contract-lib.mjs";

const EXPECTED_REPOSITORY = "https://github.com/PleasePrompto/notebooklm-mcp.git";
const commit = process.argv[2];
const output = resolve(process.argv[3] ?? "UPSTREAM_BASELINE.json");
const tag = process.argv[4] ?? "v2.0.0";
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
  throw new Error("usage: generate-upstream-baseline.mjs <exact-40-sha> [output] [tag]");
}
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) {
  throw new Error(`invalid upstream tag: ${tag}`);
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "notebooklm-upstream-baseline-"));
try {
  const commitType = execFileSync("git", ["cat-file", "-t", commit], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (commitType !== "commit") throw new Error(`${commit} is not a commit`);

  execFileSync("git", ["archive", commit, "-o", join(temporary, "source.tar")], { cwd: root });
  execFileSync("tar", ["-xf", join(temporary, "source.tar"), "-C", temporary]);
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: temporary,
    stdio: "inherit",
  });
  execFileSync(join(temporary, "node_modules", ".bin", "tsc"), [], {
    cwd: temporary,
    stdio: "inherit",
  });
  const tools = await loadToolContracts(join(temporary, "dist"));
  const contractJson = stableJson(tools);
  const lineageRoot = resolveLineageRoot();
  const baseline = {
    formatVersion: 1,
    upstream: {
      repository: EXPECTED_REPOSITORY,
      tag,
      auditTagRef: `refs/tags/upstream/notebooklm/${tag}`,
      commit,
      tree: execFileSync("git", ["rev-parse", `${commit}^{tree}`], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    },
    normalization: {
      ignoredSchemaKeys: ["description", "title"],
      capabilityAnnotations: [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ],
      capabilityCompatibility:
        "Exact match or monotonic safety improvement: readOnly/idempotent false-to-true; destructive/openWorld true-to-false.",
    },
    toolCount: tools.length,
    contractSha256: sha256(contractJson),
    lineageRoot,
    tools,
  };
  writeFileSync(output, stableJson(baseline), { mode: 0o644 });
  process.stdout.write(`Wrote ${output} with ${tools.length} upstream tool contracts\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function resolveLineageRoot() {
  const existingPath = join(root, "UPSTREAM_BASELINE.json");
  if (existsSync(existingPath)) {
    const existing = JSON.parse(readFileSync(existingPath, "utf8"));
    if (existing.lineageRoot) return existing.lineageRoot;
  }

  const provenance = JSON.parse(
    readFileSync(join(root, "RELEASE_PROVENANCE.json"), "utf8"),
  );
  const rootUpstream = provenance.upstream?.commit;
  if (!/^[0-9a-f]{40}$/.test(rootUpstream ?? "")) {
    throw new Error("release provenance has no exact root upstream commit");
  }
  const candidates = git("rev-list", "--merges", "HEAD")
    .split("\n")
    .filter(Boolean)
    .filter((candidate) => {
      const parents = git("show", "-s", "--format=%P", candidate).split(" ");
      if (parents.length !== 2 || parents[1] !== rootUpstream) return false;
      return git("rev-parse", `${candidate}^{tree}`) === git("rev-parse", `${parents[0]}^{tree}`);
    });
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one tree-preserving root graft for ${rootUpstream}; found ${candidates.length}`,
    );
  }
  const graftCommit = candidates[0];
  const [publicParent, upstreamParent] = git("show", "-s", "--format=%P", graftCommit).split(
    " ",
  );
  return {
    graftCommit,
    publicParent,
    upstreamParent,
    preservedTree: git("rev-parse", `${graftCommit}^{tree}`),
  };
}
