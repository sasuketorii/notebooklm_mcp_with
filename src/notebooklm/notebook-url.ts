const PATH = /^\/notebook\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertNotebookLmUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Notebook URL must be a valid HTTPS NotebookLM URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "notebooklm.google.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !PATH.test(url.pathname)
  ) {
    throw new Error("Notebook URL must be https://notebooklm.google.com/notebook/<uuid>.");
  }
  return url.toString();
}
