import assert from "node:assert/strict";
import {
  classifySourceRows,
  inspectSourceReadiness,
  waitForSourceReady,
} from "../dist/notebooklm/source-readiness.js";
globalThis.window = { getComputedStyle: () => ({ display: "", visibility: "" }) };

const row = (name, busy = false, error = false, readyEvidence = true) => ({
  name,
  text: name,
  busy,
  error,
  readyEvidence,
});
assert.equal(classifySourceRows([row("Alpha")])[0].status, "ready");
assert.equal(classifySourceRows([row("Alpha", false, false, false)])[0].status, "processing");
assert.equal(classifySourceRows([row("Alpha", true)])[0].status, "processing");
assert.equal(classifySourceRows([row("Alpha", false, true)])[0].status, "error");
assert.equal(classifySourceRows([], ["Alpha"])[0].status, "not_found");
assert.equal(classifySourceRows([row("Alpha")], ["Al"])[0].status, "not_found");
assert.equal(classifySourceRows([row("Ａｌｐｈａ")], ["alpha"])[0].status, "ready");

const pageFor = (rows) => ({ locator: () => ({ evaluateAll: async () => rows }) });
const inspected = await inspectSourceReadiness(pageFor([row("Alpha")]), { sourceNames: ["Alpha"] });
assert.equal(inspected.overall, "ready");
// DOM-equivalent snapshot: no checkbox, but an enabled exact stretched button
// is sufficient readiness evidence; busy/error still override it.
const domRow = ({ busy = false, error = false } = {}) => {
  const button = { disabled: false, getAttribute: (key) => (key === "aria-label" ? "Alpha" : null), textContent: "" };
  const element = {
    textContent: `${busy ? "processing" : ""}${error ? "error" : ""}`,
    querySelectorAll: (selector) => selector.includes("source-stretched-button") ? [button] : [],
    querySelector: (selector) => selector.includes("source-title") ? { textContent: "Alpha" } : null,
  };
  return { locator: () => ({ evaluateAll: async (fn) => fn([element]) }) };
};
assert.equal((await inspectSourceReadiness(domRow(), { sourceNames: ["Alpha"] })).overall, "ready");
assert.equal((await inspectSourceReadiness(domRow({ busy: true }), { sourceNames: ["Alpha"] })).overall, "processing");
assert.equal((await inspectSourceReadiness(domRow({ error: true }), { sourceNames: ["Alpha"] })).overall, "error");
const timed = await waitForSourceReady(pageFor([row("Alpha", true)]), {
  sourceNames: ["Alpha"],
  timeoutMs: 60,
  pollIntervalMs: 50,
});
assert.equal(timed.status, "timeout");
const failed = await waitForSourceReady(pageFor([row("Alpha", false, true)]), {
  sourceNames: ["Alpha"],
  timeoutMs: 500,
  pollIntervalMs: 50,
});
assert.equal(failed.status, "error");
assert.equal(failed.overall, "error");
let calls = 0;
const changing = { locator: () => ({ evaluateAll: async () => [row("Alpha", calls++ < 1)] }) };
const ready = await waitForSourceReady(changing, {
  sourceNames: ["Alpha"],
  timeoutMs: 500,
  pollIntervalMs: 50,
  stablePolls: 2,
});
assert.equal(ready.status, "ready");

// Faithful Page/Locator mock for exclusive selection: snapshots, selects target,
// and restores all checkboxes both on success and on thrown operation.
const makeSelectionPage = (input = {}) => {
  const controls = input.controls ?? [
    { checked: true, row: "Alpha", role: "checkbox" },
    { checked: false, row: "Beta", role: "checkbox" },
  ];
  let operationPhase = false;
  const materialize = (control) => ({
    get checked() {
      return control.checked;
    },
    get disabled() {
      return Boolean(control.disabled);
    },
    getAttribute: (name) => (name === "aria-checked" ? (control.ariaChecked ?? null) : null),
    closest: () => ({ querySelector: () => ({ textContent: control.row }) }),
    click: () => {
      if (operationPhase && control.failRestore) throw new Error("restore click failed");
      if (control.stuck) return;
      const next = !(control.checked || control.ariaChecked === "true");
      control.checked = next;
      control.ariaChecked = next ? "true" : "false";
    },
  });
  const locator = {
    count: async () => 1,
    filter: () => locator,
    nth: (index) => ({
      locator: () => ({
        evaluateAll: async (fn) => fn([materialize(controls[index])]),
      }),
    }),
    evaluateAll: async (fn, arg) => fn(controls.map(materialize), arg),
  };
  const rowsLocator = {
    evaluateAll: async (fn, arg) =>
      fn(
        controls.map((control) => ({ querySelector: () => ({ textContent: control.row }) })),
        arg
      ),
    nth: (index) => ({
      locator: () => ({
        evaluateAll: async (fn) => fn([materialize(controls[index])]),
      }),
    }),
  };
  return {
    locator: (selector) => (selector === ".single-source-container" ? rowsLocator : locator),
    controls,
    beginOperation: () => {
      operationPhase = true;
    },
  };
};
const { withExclusiveSourceSelection } = await import("../dist/notebooklm/source-readiness.js");
const successPage = makeSelectionPage();
await withExclusiveSourceSelection(successPage, "Beta", async () => {
  assert.deepEqual(
    successPage.controls.map((c) => c.checked),
    [false, true]
  );
});
assert.deepEqual(
  successPage.controls.map((c) => c.checked),
  [true, false]
);
const throwPage = makeSelectionPage();
await assert.rejects(() =>
  withExclusiveSourceSelection(throwPage, "Beta", async () => {
    throw new Error("boom");
  })
);
assert.deepEqual(
  throwPage.controls.map((c) => c.checked),
  [true, false]
);

// Substring-only titles must not match, and no selection controls is fail-closed.
const substringPage = makeSelectionPage({
  controls: [{ checked: false, row: "Alpha (partial)", role: "checkbox" }],
});
await assert.rejects(
  () => withExclusiveSourceSelection(substringPage, "Alpha"),
  /Exact source row/
);
const noControlsPage = makeSelectionPage({ controls: [] });
await assert.rejects(
  () => withExclusiveSourceSelection(noControlsPage, "Alpha"),
  /Exact source row/
);

// Disabled controls are never toggled.
const disabledPage = makeSelectionPage({
  controls: [{ checked: false, row: "Alpha", role: "checkbox", disabled: true }],
});
await assert.rejects(() => withExclusiveSourceSelection(disabledPage, "Alpha"), /disabled/);

// ARIA checkbox states are honoured and exactly restored.
const ariaPage = makeSelectionPage({
  controls: [
    { checked: false, ariaChecked: "true", row: "Alpha", role: "checkbox" },
    { checked: false, ariaChecked: "false", row: "Beta", role: "checkbox" },
  ],
});
await withExclusiveSourceSelection(ariaPage, "ＡＬＰＨＡ", async () => {
  assert.deepEqual(
    ariaPage.controls.map((c) => c.ariaChecked),
    ["true", "false"]
  );
});
assert.deepEqual(
  ariaPage.controls.map((c) => c.ariaChecked),
  ["true", "false"]
);

// A click that does not change state is rejected before invoking the operation.
let operationCalls = 0;
const stuckPage = makeSelectionPage({
  controls: [{ checked: false, row: "Alpha", role: "checkbox", failRestore: false }],
});
stuckPage.controls[0].checked = false;
stuckPage.controls[0].ariaChecked = "false";
stuckPage.controls[0].stuck = true;
await assert.rejects(
  () =>
    withExclusiveSourceSelection(stuckPage, "Alpha", async () => {
      operationCalls += 1;
    }),
  /selection failed|restore click failed/
);
assert.equal(operationCalls, 0);

// Restore failures are surfaced rather than swallowed.
const restoreFailurePage = makeSelectionPage({
  controls: [
    { checked: true, row: "Alpha", role: "checkbox", failRestore: true },
    { checked: false, row: "Beta", role: "checkbox" },
  ],
});
await assert.rejects(
  () =>
    withExclusiveSourceSelection(restoreFailurePage, "Beta", async () => {
      restoreFailurePage.beginOperation();
    }),
  /restore click failed/
);
console.log("source readiness tests: PASS");
