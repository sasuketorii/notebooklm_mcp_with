import assert from "node:assert/strict";
import { addYouTubeSource, validateYouTubeUrl } from "../dist/notebooklm/youtube-source.js";
import { stabilizedNewSourceNames } from "../dist/notebooklm/sources.js";

assert.equal(
  validateYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);
assert.equal(
  validateYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc&t=12"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);
assert.equal(
  validateYouTubeUrl(`https://youtu.be/dQw4w9WgXcQ?si=${"x".repeat(1800)}`),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);
assert.equal(
  validateYouTubeUrl("https://youtu.be/dQw4w9WgXcQ/"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);
assert.equal(
  validateYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?si=abc&t=12"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);
assert.equal(
  validateYouTubeUrl("https://m.youtube.com/shorts/AbCdEf12345"),
  "https://www.youtube.com/shorts/AbCdEf12345"
);
for (const value of [
  "http://youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtube.com/watch?v=dQw4w9WgXcQ&foo=x",
  "https://youtube.com/embed/dQw4w9WgXcQ",
  "https://evil.example/watch?v=dQw4w9WgXcQ",
  "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtu.be/dQw4w9WgXcQ?foo=x",
])
  assert.throws(() => validateYouTubeUrl(value));
console.log("youtube source validation: PASS");

// Minimal realistic locator harness: a hidden emoji/search input precedes the
// visible URL textarea. A page-wide input selector must not pick the hidden node.
const state = { rows: ["existing source"], submitted: false };
const loc = (selector) => ({
  first() {
    return this;
  },
  async count() {
    return selector.includes("single-source") ? state.rows.length : 0;
  },
  async allTextContents() {
    return selector.includes("single-source") ? [...state.rows] : [];
  },
  async evaluateAll(fn) {
    if (!selector.includes("single-source")) return [];
    return state.rows.map((title) => title);
  },
  async isVisible() {
    return !selector.includes('input[type="text"]');
  },
  async waitFor() {},
  async fill(value) {
    if (selector.includes("textarea") || selector.includes("formcontrolname")) this.value = value;
  },
  async click() {
    if (selector.includes("mdc-button")) {
      state.submitted = true;
      state.rows.push("A newly imported YouTube video");
    }
  },
  async isDisabled() {
    return false;
  },
  locator(s) {
    return loc(`${selector} ${s}`);
  },
});
const fakePage = {
  locator: (selector) => loc(selector),
  url: () => "https://notebooklm.google.com/notebook/abc",
};
const result = await addYouTubeSource(fakePage, {
  url: "https://youtu.be/dQw4w9WgXcQ",
  timeoutMs: 1000,
});
assert.equal(result.status, "INDETERMINATE");
assert.deepEqual(result.verifiedSourceRows, []);
assert.deepEqual(result.sourceNames, []);
assert.equal(result.identityConfidence, "none");
assert.equal(state.submitted, true);
console.log("youtube source mocked DOM flow: PASS");

// A normal hydrated title (without the 11-character ID) must still be sent
// through viewer identity verification.
const verifiedState = { rows: ["existing source"], polls: 0, clicked: false, submitted: false };
const verifiedPage = {
  url: () => "https://notebooklm.google.com/notebook/abc",
  locator(selector) {
    if (selector.includes("single-source")) {
      return {
        count: async () => verifiedState.rows.length + (verifiedState.submitted ? 1 : 0),
        evaluateAll: async () => {
          verifiedState.polls++;
          return verifiedState.submitted
            ? [...verifiedState.rows, "A normal video title"]
            : [...verifiedState.rows];
        },
      };
    }
    if (selector === "source-viewer")
      return { locator: (child) => verifiedPage.locator(`source-viewer ${child}`) };
    if (selector.startsWith("source-viewer iframe")) return { count: async () => 1, first() { return this; }, getAttribute: async () => "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" };
    if (selector.includes("#source-title")) return { getAttribute: async () => "A normal video title" };
    const fallback = loc(selector);
    fallback.locator = (child) => verifiedPage.locator(`${selector} ${child}`);
    if (selector.includes("mdc-button")) fallback.click = async () => {
      verifiedState.submitted = true;
    };
    return fallback;
  },
  getByRole: () => ({ count: async () => 1, evaluate: async (fn) => { verifiedState.clicked = true; fn({ click() {} }); } }),
  goto: async () => {},
};
const verified = await addYouTubeSource(verifiedPage, { url: "https://youtu.be/dQw4w9WgXcQ", timeoutMs: 3000 });
assert.equal(verified.status, "CONFIRMED");
assert.equal(verified.identityConfidence, "exact-dom-video-id");
assert.equal(verifiedState.clicked, true);

// A mismatched embed ID must remain indeterminate.
const wrongIdPage = { ...verifiedPage,
  locator(selector) {
    const result = verifiedPage.locator(selector);
    if (selector.startsWith("source-viewer iframe")) result.getAttribute = async () => "https://www.youtube-nocookie.com/embed/AbCdEf12345";
    return result;
  }
};
const wrong = await addYouTubeSource(wrongIdPage, { url: "https://youtu.be/dQw4w9WgXcQ", timeoutMs: 3000 });
assert.equal(wrong.status, "INDETERMINATE");
assert.equal(wrong.identityConfidence, "none");
console.log("youtube viewer identity verification tests: PASS");

const sourceSequencePage = (sequence) => ({
  locator: () => ({ evaluateAll: async () => sequence[Math.min(sequence.length - 1, sourceSequencePage.i++)] }),
});
sourceSequencePage.i = 0;
const stablePage = sourceSequencePage([["old"], ["https://youtube.com/watch?v=x"], ["Imported title"], ["Imported title"], ["Imported title"]]);
assert.deepEqual(await stabilizedNewSourceNames(stablePage, 1, ["old"], 3), ["Imported title"]);
sourceSequencePage.i = 0;
const ambiguousPage = sourceSequencePage([["old"], ["A", "B"]]);
assert.deepEqual(await stabilizedNewSourceNames(ambiguousPage, 1, ["old"], 1), []);
console.log("add_source title stabilization tests: PASS");
