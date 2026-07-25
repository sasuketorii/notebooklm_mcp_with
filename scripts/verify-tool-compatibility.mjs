#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareExactToolContracts,
  compareToolContracts,
  loadToolContracts,
  sha256,
  stableJson,
} from "./tool-contract-lib.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baselinePath = resolve(process.argv[2] ?? `${root}/UPSTREAM_BASELINE.json`);
const customPath = resolve(process.argv[3] ?? `${root}/CUSTOM_TOOL_CONTRACTS.json`);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const customBaseline = JSON.parse(readFileSync(customPath, "utf8"));
const expectedHash = sha256(stableJson(baseline.tools));
if (baseline.contractSha256 !== expectedHash) {
  throw new Error(
    `baseline contract hash mismatch: expected ${baseline.contractSha256}, calculated ${expectedHash}`,
  );
}
if (baseline.toolCount !== baseline.tools.length) {
  throw new Error("baseline toolCount does not match tools");
}
const expectedCustomHash = sha256(stableJson(customBaseline.tools));
if (customBaseline.contractSha256 !== expectedCustomHash) {
  throw new Error("custom contract hash mismatch");
}
if (customBaseline.toolCount !== customBaseline.tools.length) {
  throw new Error("custom toolCount does not match tools");
}

const currentTools = await loadToolContracts(joinPath(root, "dist"));
const result = compareToolContracts(baseline.tools, currentTools);
const currentByName = new Map(currentTools.map((tool) => [tool.name, tool]));
const currentCustomTools = result.customOnlyTools.map((name) => currentByName.get(name));
result.errors.push(
  ...compareExactToolContracts(customBaseline.tools, currentCustomTools),
);
if (result.errors.length > 0) {
  process.stderr.write(`Upstream compatibility verification failed:\n- ${result.errors.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Upstream compatibility verified: ${baseline.tools.length} upstream tools preserved; ` +
    `${result.customOnlyTools.length} exact custom-only contracts: ${result.customOnlyTools.join(", ") || "(none)"}\n`,
);

function joinPath(...parts) {
  return parts.join("/").replaceAll(/\/+/g, "/");
}
