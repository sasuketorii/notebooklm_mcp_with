import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CAPABILITY_ANNOTATIONS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
];

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

function normalizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "description" && key !== "title")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        if (key === "properties" && value && typeof value === "object") {
          return [
            key,
            Object.fromEntries(
              Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([property, propertySchema]) => [
                  property,
                  normalizeSchema(propertySchema),
                ]),
            ),
          ];
        }
        if (Array.isArray(value) && ["required", "enum", "type"].includes(key)) {
          return [
            key,
            value
              .map(normalizeSchema)
              .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
          ];
        }
        return [key, normalizeSchema(value)];
      }),
  );
}

export function normalizeTool(tool) {
  const annotations = Object.fromEntries(
    CAPABILITY_ANNOTATIONS.filter((key) => tool.annotations?.[key] !== undefined).map(
      (key) => [key, tool.annotations[key]],
    ),
  );
  return {
    name: tool.name,
    inputSchema: normalizeSchema(tool.inputSchema ?? { type: "object" }),
    annotations: sortValue(annotations),
  };
}

export function normalizeTools(tools) {
  return tools.map(normalizeTool).sort((left, right) => left.name.localeCompare(right.name));
}

export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadToolContracts(distRoot) {
  const moduleUrl = pathToFileURL(join(distRoot, "tools", "definitions.js"));
  const { buildToolDefinitions } = await import(`${moduleUrl.href}?contract=${Date.now()}`);
  const library = {
    getActiveNotebook() {
      return null;
    },
  };
  return normalizeTools(buildToolDefinitions(library));
}

function schemaTypes(schema) {
  if (Array.isArray(schema?.type)) return new Set(schema.type);
  if (typeof schema?.type === "string") return new Set([schema.type]);
  return null;
}

function pathLabel(path) {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}

export function compareSchemas(upstream, current, path = []) {
  const errors = [];
  if (!current || typeof current !== "object") {
    return [`${pathLabel(path)}: current schema is missing`];
  }

  const upstreamTypes = schemaTypes(upstream);
  const currentTypes = schemaTypes(current);
  if (upstreamTypes && currentTypes) {
    for (const type of upstreamTypes) {
      if (!currentTypes.has(type)) {
        errors.push(`${pathLabel(path)}: current schema no longer accepts type ${type}`);
      }
    }
  } else if (upstreamTypes && !currentTypes) {
    // No type constraint widens the accepted input and is compatible.
  } else if (!upstreamTypes && currentTypes) {
    errors.push(`${pathLabel(path)}: current schema adds a type constraint`);
  }

  if (Array.isArray(upstream.enum)) {
    if (!Array.isArray(current.enum)) {
      // Removing an enum widens the contract.
    } else {
      for (const value of upstream.enum) {
        if (!current.enum.some((candidate) => Object.is(candidate, value))) {
          errors.push(`${pathLabel(path)}: current enum removed ${JSON.stringify(value)}`);
        }
      }
    }
  } else if (Array.isArray(current.enum)) {
    errors.push(`${pathLabel(path)}: current schema adds an enum constraint`);
  }

  for (const key of [
    "minimum",
    "exclusiveMinimum",
    "minLength",
    "minItems",
    "minProperties",
  ]) {
    if (typeof current[key] === "number") {
      if (typeof upstream[key] !== "number" || current[key] > upstream[key]) {
        errors.push(`${pathLabel(path)}: current ${key}=${current[key]} narrows upstream`);
      }
    }
  }
  for (const key of [
    "maximum",
    "exclusiveMaximum",
    "maxLength",
    "maxItems",
    "maxProperties",
  ]) {
    if (typeof current[key] === "number") {
      if (typeof upstream[key] !== "number" || current[key] < upstream[key]) {
        errors.push(`${pathLabel(path)}: current ${key}=${current[key]} narrows upstream`);
      }
    }
  }

  if (
    upstream.additionalProperties !== false &&
    (current.additionalProperties === false ||
      (current.additionalProperties && typeof current.additionalProperties === "object"))
  ) {
    errors.push(`${pathLabel(path)}: current schema narrows additional properties`);
  } else if (
    upstream.additionalProperties &&
    typeof upstream.additionalProperties === "object"
  ) {
    if (current.additionalProperties === undefined || current.additionalProperties === true) {
      // Removing a schema constraint widens the contract.
    } else if (current.additionalProperties === false) {
      errors.push(`${pathLabel(path)}: current schema forbids additional properties`);
    } else {
      errors.push(
        ...compareSchemas(upstream.additionalProperties, current.additionalProperties, [
          ...path,
          "additionalProperties",
        ]),
      );
    }
  }
  if (upstream.uniqueItems !== true && current.uniqueItems === true) {
    errors.push(`${pathLabel(path)}: current schema newly requires unique items`);
  }
  if (current.multipleOf !== undefined) {
    if (upstream.multipleOf === undefined) {
      errors.push(`${pathLabel(path)}: current schema adds a multipleOf constraint`);
    } else if (current.multipleOf !== upstream.multipleOf) {
      errors.push(`${pathLabel(path)}: multipleOf change requires review`);
    }
  }

  const upstreamRequired = new Set(upstream.required ?? []);
  for (const field of current.required ?? []) {
    if (!upstreamRequired.has(field)) {
      errors.push(`${pathLabel(path)}: current schema newly requires ${field}`);
    }
  }

  for (const [name, schema] of Object.entries(upstream.properties ?? {})) {
    if (!(name in (current.properties ?? {}))) {
      errors.push(`${pathLabel([...path, "properties", name])}: upstream property is missing`);
      continue;
    }
    errors.push(
      ...compareSchemas(schema, current.properties[name], [...path, "properties", name]),
    );
  }

  if (upstream.items) {
    if (!current.items) {
      // Removing item constraints widens the contract.
    } else if (Array.isArray(upstream.items) || Array.isArray(current.items)) {
      if (JSON.stringify(upstream.items) !== JSON.stringify(current.items)) {
        errors.push(`${pathLabel([...path, "items"])}: tuple schemas must remain identical`);
      }
    } else {
      errors.push(...compareSchemas(upstream.items, current.items, [...path, "items"]));
    }
  }

  const exactModeledKeywords = ["allOf", "anyOf", "oneOf", "not", "const", "pattern", "format"];
  for (const composition of exactModeledKeywords) {
    if (upstream[composition] !== undefined || current[composition] !== undefined) {
      if (JSON.stringify(upstream[composition]) !== JSON.stringify(current[composition])) {
        errors.push(`${pathLabel(path)}: unsupported ${composition} change requires review`);
      }
    }
  }
  const modeledKeywords = new Set([
    "type",
    "enum",
    "minimum",
    "exclusiveMinimum",
    "maximum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "additionalProperties",
    "uniqueItems",
    "multipleOf",
    "required",
    "properties",
    "items",
    ...exactModeledKeywords,
  ]);
  for (const keyword of new Set([
    ...Object.keys(upstream),
    ...Object.keys(current),
  ])) {
    if (modeledKeywords.has(keyword)) continue;
    if (JSON.stringify(upstream[keyword]) !== JSON.stringify(current[keyword])) {
      errors.push(
        `${pathLabel(path)}: unmodelled schema keyword ${keyword} changed; manual compatibility review required`,
      );
    }
  }
  return errors;
}

export function compareToolContracts(upstreamTools, currentTools) {
  const errors = [];
  const currentByName = new Map(currentTools.map((tool) => [tool.name, tool]));
  for (const upstream of upstreamTools) {
    const current = currentByName.get(upstream.name);
    if (!current) {
      errors.push(`${upstream.name}: upstream tool is missing`);
      continue;
    }
    errors.push(
      ...compareSchemas(upstream.inputSchema, current.inputSchema).map(
        (error) => `${upstream.name}: ${error}`,
      ),
    );
    for (const [key, value] of Object.entries(upstream.annotations ?? {})) {
      const currentValue = current.annotations?.[key];
      const safeCapabilityChange =
        (key === "readOnlyHint" && value === false && currentValue === true) ||
        (key === "destructiveHint" && value === true && currentValue === false) ||
        (key === "idempotentHint" && value === false && currentValue === true) ||
        (key === "openWorldHint" && value === true && currentValue === false);
      if (currentValue !== value && !safeCapabilityChange) {
        errors.push(
          `${upstream.name}: capability annotation ${key} changed incompatibly from ${JSON.stringify(value)} to ${JSON.stringify(currentValue)}`,
        );
      }
    }
  }
  return {
    errors,
    customOnlyTools: currentTools
      .filter((tool) => !upstreamTools.some((upstream) => upstream.name === tool.name))
      .map((tool) => tool.name)
      .sort(),
  };
}

export function compareExactToolContracts(expectedTools, currentTools) {
  const errors = [];
  const expectedByName = new Map(expectedTools.map((tool) => [tool.name, tool]));
  const currentByName = new Map(currentTools.map((tool) => [tool.name, tool]));
  for (const [name, expected] of expectedByName) {
    const current = currentByName.get(name);
    if (!current) {
      errors.push(`${name}: reviewed custom tool is missing`);
    } else if (stableJson(expected) !== stableJson(current)) {
      errors.push(`${name}: reviewed custom schema or capability annotations changed`);
    }
  }
  for (const name of currentByName.keys()) {
    if (!expectedByName.has(name)) errors.push(`${name}: unreviewed custom tool was added`);
  }
  return errors;
}
