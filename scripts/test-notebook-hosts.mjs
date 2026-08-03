import assert from "node:assert/strict";
import { NOTEBOOKLM_AUTH_URL } from "../dist/config.js";
import { AuthManager } from "../dist/auth/auth-manager.js";
import {
  NOTEBOOKLM_APP_ORIGIN,
  classifyNotebookLmAppUrl,
  isNotebookLmAuthDestination,
  isNotebookLmAppUrl,
} from "../dist/notebooklm/notebook-host.js";
import { assertNotebookLmUrl, getNotebookLmId } from "../dist/notebooklm/notebook-url.js";

const uuid = "12345678-1234-1234-1234-123456789012";
const hosts = ["notebooklm.google.com", "notebook.google.com"];
const validCookies = () => [
  {
    name: "SID",
    value: "test-only-cookie",
    domain: ".google.com",
    path: "/",
    expires: Date.now() / 1000 + 3600,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  },
];
const pageFor = (url, cookies = validCookies()) => ({
  goto: async () => undefined,
  url: () => url,
  context: () => ({ cookies: async () => cookies }),
  waitForTimeout: async () => undefined,
});

for (const host of hosts) {
  const root = `https://${host}/?pli=1`;
  const notebook = `https://${host}/notebook/${uuid}?authuser=0`;
  assert.equal(isNotebookLmAppUrl(root), true);
  assert.equal(isNotebookLmAuthDestination(root), true);
  assert.equal(isNotebookLmAuthDestination(notebook), true);
  assert.equal(classifyNotebookLmAppUrl(notebook), host);
  assert.equal(new URL(assertNotebookLmUrl(notebook)).hostname, host);
  assert.equal(getNotebookLmId(notebook), uuid);

  let requestedUrl;
  const page = pageFor(root);
  page.goto = async (url) => {
    requestedUrl = url;
  };
  assert.equal(await new AuthManager().performLogin(page), true);
  assert.equal(requestedUrl, NOTEBOOKLM_AUTH_URL);

  for (const path of ["/login", "/challenge", "/signin", "/error", "/transient"]) {
    assert.equal(isNotebookLmAuthDestination(`https://${host}${path}`), false);
    assert.equal(
      await new AuthManager().hasAuthenticatedNotebookDestination(
        pageFor(`https://${host}${path}`),
        `https://${host}${path}`
      ),
      false
    );
  }
  assert.equal(
    await new AuthManager().hasAuthenticatedNotebookDestination(pageFor(root, []), root),
    false
  );
  assert.equal(
    await new AuthManager().hasAuthenticatedNotebookDestination(
      pageFor(root, [{ name: "SID", value: "malformed" }]),
      root
    ),
    false
  );
  assert.equal(
    await new AuthManager().hasAuthenticatedNotebookDestination(
      {
        context: () => {
          throw new Error("unavailable");
        },
      },
      root
    ),
    false
  );
  assert.equal(
    await new AuthManager().hasAuthenticatedNotebookDestination(
      pageFor(root, [{ ...validCookies()[0], expires: -1 }]),
      root
    ),
    true
  );
}

assert.equal(
  new URL(NOTEBOOKLM_AUTH_URL).searchParams.get("continue"),
  `${NOTEBOOKLM_APP_ORIGIN}/`
);
assert.equal(
  await new AuthManager().performLogin(pageFor("https://notebook.google.com/login")),
  false,
  "an official but non-destination page must not reach setup state saving"
);
assert.equal(getNotebookLmId(`https://notebook.google.com/notebook/${uuid}?authuser=1`), uuid);
assert.notEqual(
  getNotebookLmId(`https://notebook.google.com/notebook/${uuid}?authuser=1`),
  getNotebookLmId("https://notebooklm.google.com/notebook/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
);
assert.equal(
  "NOTEBOOKLM_APP_HOSTS" in (await import("../dist/notebooklm/notebook-host.js")),
  false
);

for (const value of [
  "http://notebook.google.com/",
  "https://notebook.google.com:443/",
  "https://notebook.google.com:444/",
  "https://notebook.google.com:/",
  "https://user@notebook.google.com/",
  "https://user:pass@notebook.google.com/",
  "https://notebook.google.com./",
  "https://evilnotebook.google.com/",
  "https://notebook.google.com.example.org/",
  "https://notebook.google.com%2Eexample.org/",
  "not a URL",
]) {
  assert.equal(isNotebookLmAppUrl(value), false, value);
  assert.throws(() => assertNotebookLmUrl(`${value}/notebook/${uuid}`));
}

// WHATWG URL normalizes the Unicode IDEOGRAPHIC FULL STOP to an ASCII dot.
assert.equal(isNotebookLmAppUrl("https://notebook\u3002google\u3002com/"), true);
assert.equal(isNotebookLmAuthDestination("https://notebook.google.com/#ready"), true);

for (const value of [
  `http://notebook.google.com/notebook/${uuid}`,
  `https://notebook.google.com:443/notebook/${uuid}`,
  `https://notebook.google.com:444/notebook/${uuid}`,
  `https://user:pass@notebook.google.com/notebook/${uuid}`,
  `https://evilnotebook.google.com/notebook/${uuid}`,
  `https://notebook.google.com.example.org/notebook/${uuid}`,
  "https://notebook.google.com/notebook/not-a-uuid",
  "https://notebook.google.com/notebook/12345678-1234-1234-1234-123456789012/extra",
  "not a URL",
]) {
  assert.throws(() => assertNotebookLmUrl(value), undefined, value);
}

process.stdout.write("NotebookLM host compatibility tests passed\n");
