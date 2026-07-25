#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadToolContracts, sha256, stableJson } from "./tool-contract-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.argv[2] ?? join(root, "CUSTOM_TOOL_CONTRACTS.json"));
const baseline = JSON.parse(readFileSync(join(root, "UPSTREAM_BASELINE.json"), "utf8"));
const upstreamNames = new Set(baseline.tools.map((tool) => tool.name));
const allTools = await loadToolContracts(join(root, "dist"));
const tools = allTools.filter((tool) => !upstreamNames.has(tool.name));
if (tools.length === 0) throw new Error("no custom-only tools found");
const contractJson = stableJson(tools);
const artifact = {
  formatVersion: 1,
  toolCount: tools.length,
  contractSha256: sha256(contractJson),
  tools,
};
writeFileSync(output, stableJson(artifact), { mode: 0o644 });
process.stdout.write(`Wrote ${output} with ${tools.length} exact custom tool contracts\n`);
