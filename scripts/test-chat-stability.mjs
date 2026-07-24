import assert from "node:assert/strict";
import { waitForStableAnswer } from "../dist/notebooklm/chat.js";

function pageFrom(states) {
  let index = 0;
  const locator = {
    last() {
      return this;
    },
    async evaluate() {
      return states[Math.min(index++, states.length - 1)];
    },
  };
  return {
    locator() {
      return locator;
    },
  };
}

const intermediate = { text: "A stable partial answer", finalized: false };
const final = { text: "A stable complete answer", finalized: true };

const neverFinal = await waitForStableAnswer(pageFrom([intermediate]), {
  timeoutMs: 25,
  pollIntervalMs: 1,
  stablePolls: 2,
});
assert.equal(neverFinal, null, "streaming intermediate text must not be returned");

const transitions = await waitForStableAnswer(pageFrom([intermediate, final, final, final]), {
  timeoutMs: 100,
  pollIntervalMs: 1,
  stablePolls: 2,
});
assert.equal(transitions, final.text);

const globalSpinner = await waitForStableAnswer(pageFrom([final, final]), {
  timeoutMs: 100,
  pollIntervalMs: 1,
  stablePolls: 2,
});
assert.equal(globalSpinner, final.text, "page-global spinner must not block finalization");

const localSpinner = await waitForStableAnswer(pageFrom([{ text: final.text, finalized: false }]), {
  timeoutMs: 25,
  pollIntervalMs: 1,
  stablePolls: 2,
});
assert.equal(localSpinner, null, "container-local progress must block finalization");

const error = await waitForStableAnswer(
  pageFrom([{ text: "The system could not respond", finalized: false }]),
  { timeoutMs: 100, pollIntervalMs: 1, stablePolls: 3 }
);
assert.equal(error, "The system could not respond");

console.log("chat stability tests passed");
