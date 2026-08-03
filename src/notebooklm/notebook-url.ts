import { parseNotebookLmAppUrl } from "./notebook-host.js";

const PATH = /^\/notebook\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function assertNotebookLmUrl(value: string): string {
  const url = parseNotebookLmAppUrl(value);
  if (!url) {
    throw new Error("Notebook URL must be a valid HTTPS NotebookLM URL.");
  }
  if (!PATH.test(url.pathname)) {
    throw new Error(
      "Notebook URL must use https://notebooklm.google.com/notebook/<uuid> or https://notebook.google.com/notebook/<uuid>."
    );
  }
  return url.toString();
}

/** Stable notebook resource identity; host and query are navigation details. */
export function getNotebookLmId(value: string): string {
  const normalized = assertNotebookLmUrl(value);
  const id = new URL(normalized).pathname.match(PATH)?.[1];
  if (!id) throw new Error("Notebook URL must contain a notebook UUID.");
  return id.toLowerCase();
}
