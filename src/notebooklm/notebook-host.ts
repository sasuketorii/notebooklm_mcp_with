export const NOTEBOOKLM_APP_ORIGIN = "https://notebook.google.com";
export const NOTEBOOKLM_APP_URL = `${NOTEBOOKLM_APP_ORIGIN}/`;

export type NotebookLmAppHost = "notebooklm.google.com" | "notebook.google.com";

const NOTEBOOKLM_APP_HOSTS: readonly NotebookLmAppHost[] = [
  "notebooklm.google.com",
  "notebook.google.com",
];
const NOTEBOOK_PATH = /^\/notebook\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasExplicitPort(value: string): boolean {
  const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  const hostPort = authority?.slice((authority.lastIndexOf("@") ?? -1) + 1);
  return hostPort?.includes(":") ?? false;
}

/**
 * Parses an official NotebookLM application URL. Paths and query strings are
 * deliberately allowed here; callers that require a notebook URL validate its
 * pathname separately.
 */
export function parseNotebookLmAppUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    // `URL.hostname` applies WHATWG host normalization, including Unicode dot
    // separators; only its resulting exact ASCII hostname is trusted.
    !NOTEBOOKLM_APP_HOSTS.includes(url.hostname as NotebookLmAppHost) ||
    hasExplicitPort(value) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url;
}

export function classifyNotebookLmAppUrl(value: string): NotebookLmAppHost | null {
  const url = parseNotebookLmAppUrl(value);
  return url ? (url.hostname as NotebookLmAppHost) : null;
}

export function isNotebookLmAppUrl(value: string): boolean {
  return parseNotebookLmAppUrl(value) !== null;
}

/** A post-login destination; arbitrary official-host pages are not evidence of authentication. */
export function isNotebookLmAuthDestination(value: string): boolean {
  const url = parseNotebookLmAppUrl(value);
  return url !== null && (url.pathname === "/" || NOTEBOOK_PATH.test(url.pathname));
}
