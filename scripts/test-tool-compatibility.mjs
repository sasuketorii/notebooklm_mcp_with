#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  compareExactToolContracts,
  compareToolContracts,
} from "./tool-contract-lib.mjs";

const upstream = [
  {
    name: "example",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a", "b"] },
        count: { type: "number", minimum: 1, maximum: 10 },
      },
      required: ["mode"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

function clone(value) {
  return structuredClone(value);
}

const compatible = clone(upstream);
compatible[0].inputSchema.properties.mode.enum.push("c");
compatible[0].inputSchema.properties.count.minimum = 0;
compatible[0].inputSchema.properties.count.maximum = 20;
compatible[0].inputSchema.properties.note = { type: "string" };
compatible[0].inputSchema.required = [];
compatible[0].annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
compatible.push({
  name: "custom_only",
  inputSchema: { type: "object", properties: {} },
  annotations: {},
});
const compatibleResult = compareToolContracts(upstream, compatible);
assert.deepEqual(compatibleResult.errors, []);
assert.deepEqual(compatibleResult.customOnlyTools, ["custom_only"]);

const missingProperty = clone(upstream);
delete missingProperty[0].inputSchema.properties.mode;
assert.match(compareToolContracts(upstream, missingProperty).errors.join("\n"), /property is missing/);

const newlyRequired = clone(upstream);
newlyRequired[0].inputSchema.required.push("count");
assert.match(compareToolContracts(upstream, newlyRequired).errors.join("\n"), /newly requires count/);

const narrowerRange = clone(upstream);
narrowerRange[0].inputSchema.properties.count.maximum = 5;
assert.match(compareToolContracts(upstream, narrowerRange).errors.join("\n"), /narrows upstream/);

const removedEnum = clone(upstream);
removedEnum[0].inputSchema.properties.mode.enum = ["a"];
assert.match(compareToolContracts(upstream, removedEnum).errors.join("\n"), /removed "b"/);

const unsafeAnnotation = clone(upstream);
unsafeAnnotation[0].annotations.readOnlyHint = true;
upstream[0].annotations.readOnlyHint = true;
unsafeAnnotation[0].annotations.readOnlyHint = false;
assert.match(
  compareToolContracts(upstream, unsafeAnnotation).errors.join("\n"),
  /changed incompatibly/,
);

for (const [keyword, value] of [
  ["contains", { type: "string" }],
  ["minContains", 1],
  ["dependentRequired", { mode: ["count"] }],
  ["propertyNames", { pattern: "^[a-z]+$" }],
]) {
  const unknownConstraint = clone(upstream);
  unknownConstraint[0].inputSchema[keyword] = value;
  assert.match(
    compareToolContracts(upstream, unknownConstraint).errors.join("\n"),
    new RegExp(`unmodelled schema keyword ${keyword}`),
  );
}

const reviewedCustom = [
  {
    name: "custom",
    inputSchema: {
      type: "object",
      properties: { file_paths: { type: "array", items: { type: "string" } } },
      required: ["file_paths"],
    },
    annotations: { readOnlyHint: false },
  },
];
assert.deepEqual(compareExactToolContracts(reviewedCustom, clone(reviewedCustom)), []);
const customRequiredDrift = clone(reviewedCustom);
customRequiredDrift[0].inputSchema.required = [];
assert.match(
  compareExactToolContracts(reviewedCustom, customRequiredDrift).join("\n"),
  /schema or capability annotations changed/,
);

process.stdout.write("Tool compatibility synthetic tests passed\n");
