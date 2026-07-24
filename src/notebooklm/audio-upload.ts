import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "patchright";
import { Selectors } from "./selectors.js";
import { countSources } from "./sources.js";
import { safeSleep } from "../browser/watchdog.js";
import { assertNotebookLmUrl } from "./notebook-url.js";

const EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"]);
const MAX_FILES = 10,
  MAX_FILE = 200 * 1024 * 1024,
  MAX_TOTAL = 500 * 1024 * 1024;
const MIN_TIMEOUT = 30_000,
  DEFAULT_TIMEOUT = 900_000,
  MAX_TIMEOUT = 1_200_000;
export interface AudioFileReceipt {
  name: string;
  bytes: number;
  sha256: string;
}
export interface AddAudioSourceInput {
  filePaths: string[];
  timeoutMs?: number;
}
export interface AddAudioSourceResult {
  success: boolean;
  status: "CONFIRMED" | "INDETERMINATE" | "FAILED";
  sourceCountBefore: number;
  sourceCountAfter: number;
  expectedSourceNames: string[];
  verifiedSourceNames: string[];
  files: AudioFileReceipt[];
  message?: string;
}

function roots(): Promise<string[]> {
  const raw = process.env.NOTEBOOKLM_AUDIO_ROOTS;
  if (!raw)
    throw new Error("NOTEBOOKLM_AUDIO_ROOTS is required and must list approved audio directories.");
  return Promise.all(
    raw
      .split(path.delimiter)
      .filter(Boolean)
      .map((root) =>
        realpath(root).catch(() => {
          throw new Error("An approved audio root cannot be resolved.");
        })
      )
  );
}
function contained(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}${path.sep}`);
}
export function resolveUploadTimeout(value?: number): number {
  if (value === undefined) return DEFAULT_TIMEOUT;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT || value > MAX_TIMEOUT)
    throw new Error(`timeout_ms must be an integer between ${MIN_TIMEOUT} and ${MAX_TIMEOUT}.`);
  return value;
}
export function normaliseSourceName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}
export function exactVisibleNames(rows: string[], names: string[]): string[] {
  const observed = new Set(rows.map(normaliseSourceName));
  return names.filter((name) => observed.has(normaliseSourceName(name)));
}
export function classifyUploadError(uploadInitiated: boolean): AddAudioSourceResult["status"] {
  return uploadInitiated ? "INDETERMINATE" : "FAILED";
}

export async function validateAudioFiles(
  filePaths: string[]
): Promise<{ receipts: AudioFileReceipt[]; canonicalPaths: string[] }> {
  if (!Array.isArray(filePaths) || !filePaths.length)
    throw new Error("file_paths must contain at least one local audio file path.");
  if (filePaths.length > MAX_FILES)
    throw new Error(`At most ${MAX_FILES} audio files can be uploaded in one call.`);
  const approvedRoots = await roots(),
    seen = new Set<string>(),
    names = new Set<string>();
  let total = 0;
  const receipts: AudioFileReceipt[] = [],
    canonicalPaths: string[] = [];
  for (const requested of filePaths) {
    if (typeof requested !== "string" || !requested.trim())
      throw new Error("Every file_paths entry must be a non-empty path string.");
    const canonical = await realpath(requested).catch(() => {
      throw new Error("Audio file does not exist or cannot be resolved.");
    });
    if (!approvedRoots.some((root) => contained(canonical, root)))
      throw new Error("Audio file is outside NOTEBOOKLM_AUDIO_ROOTS.");
    if (seen.has(canonical)) throw new Error("Duplicate audio file path after canonicalization.");
    seen.add(canonical);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new Error("Audio path is not a regular file.");
    const extension = path.extname(canonical).toLowerCase(),
      name = path.basename(canonical);
    if (!EXTENSIONS.has(extension)) throw new Error(`Unsupported audio extension for ${name}.`);
    const normalizedName = normaliseSourceName(name);
    if (names.has(normalizedName))
      throw new Error(`Duplicate audio filename in this upload batch: ${name}.`);
    names.add(normalizedName);
    if (!metadata.size) throw new Error(`Audio file is empty: ${name}.`);
    if (metadata.size > MAX_FILE) throw new Error(`Audio file exceeds per-file limit: ${name}.`);
    total += metadata.size;
    if (total > MAX_TOTAL) throw new Error("Audio batch exceeds total safety limit.");
    await assertMagic(canonical, extension);
    receipts.push({ name, bytes: metadata.size, sha256: await digest(canonical) });
    canonicalPaths.push(canonical);
  }
  return { receipts, canonicalPaths };
}

export async function addAudioSource(
  page: Page,
  input: AddAudioSourceInput
): Promise<AddAudioSourceResult> {
  const { receipts: files, canonicalPaths } = await validateAudioFiles(input.filePaths),
    expectedSourceNames = files.map((file) => file.name),
    timeout = resolveUploadTimeout(input.timeoutMs);
  const staged = await stageValidatedFiles(canonicalPaths, files);
  const before = await countSources(page).catch(() => 0);
  let uploadInitiated = false;
  try {
    assertNotebookLmUrl(page.url());
    const existing = await visible(page, expectedSourceNames);
    if (existing.length)
      return result(
        false,
        "FAILED",
        before,
        before,
        expectedSourceNames,
        existing,
        files,
        "A requested filename already exists; zero files were uploaded to avoid ambiguity."
      );
    await openOverlay(page);
    await choose(page, staged.paths, () => {
      uploadInitiated = true;
    });
    const closed = await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "hidden", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!closed)
      return result(
        false,
        "INDETERMINATE",
        before,
        await countSources(page).catch(() => before),
        expectedSourceNames,
        await visible(page, expectedSourceNames),
        files,
        "Upload dialog did not close. Do not automatically retry; inspect the source panel first."
      );
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const after = await countSources(page).catch(() => before),
        names = await visible(page, expectedSourceNames);
      if (after >= before + files.length && names.length === files.length)
        return result(true, "CONFIRMED", before, after, expectedSourceNames, names, files);
      await safeSleep(page, 750);
    }
    return result(
      false,
      "INDETERMINATE",
      before,
      await countSources(page).catch(() => before),
      expectedSourceNames,
      await visible(page, expectedSourceNames),
      files,
      "Confirmation timed out. Do not automatically retry; inspect the source panel and retry only confirmed-missing files."
    );
  } catch (error) {
    return result(
      false,
      classifyUploadError(uploadInitiated),
      before,
      await countSources(page).catch(() => before),
      expectedSourceNames,
      [],
      files,
      `${error instanceof Error ? error.message : String(error)}${
        uploadInitiated
          ? " Upload may have started. Do not automatically retry; inspect the source panel first."
          : ""
      }`
    );
  } finally {
    await rm(staged.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function stageValidatedFiles(
  canonicalPaths: string[],
  receipts: AudioFileReceipt[]
): Promise<{ directory: string; paths: string[] }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notebooklm-audio-stage-"));
  await chmod(directory, 0o700);
  try {
    const paths: string[] = [];
    for (let index = 0; index < canonicalPaths.length; index += 1) {
      const source = await open(
        canonicalPaths[index],
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
      try {
        const metadata = await source.stat();
        if (!metadata.isFile() || metadata.size !== receipts[index].bytes)
          throw new Error(`Audio file changed after validation: ${receipts[index].name}.`);
        // Preserve the original basename: NotebookLM uses it as the source title.
        // Duplicate normalized names are rejected during validation, so this is
        // collision-free within the private staging directory.
        const stagedPath = path.join(directory, receipts[index].name);
        const target = await open(
          stagedPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600
        );
        try {
          const hash = createHash("sha256"),
            header = Buffer.alloc(128),
            chunk = Buffer.alloc(64 * 1024);
          let bytes = 0;
          for (;;) {
            const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            if (bytes < header.length)
              chunk.copy(header, bytes, 0, Math.min(bytesRead, header.length - bytes));
            bytes += bytesRead;
            if (bytes > receipts[index].bytes || bytes > MAX_FILE)
              throw new Error(`Audio file changed after validation: ${receipts[index].name}.`);
            hash.update(chunk.subarray(0, bytesRead));
            let written = 0;
            while (written < bytesRead) {
              const result = await target.write(chunk, written, bytesRead - written);
              if (!result.bytesWritten) throw new Error("Could not stage audio file completely.");
              written += result.bytesWritten;
            }
          }
          if (bytes !== receipts[index].bytes || hash.digest("hex") !== receipts[index].sha256)
            throw new Error(`Audio file changed after validation: ${receipts[index].name}.`);
          if ((await target.stat()).size !== bytes)
            throw new Error(`Could not stage audio file completely: ${receipts[index].name}.`);
          await assertMagicBuffer(
            header.subarray(0, Math.min(bytes, header.length)),
            path.extname(canonicalPaths[index]).toLowerCase(),
            receipts[index].name
          );
          paths.push(stagedPath);
        } finally {
          await target.close();
          if (!paths.includes(stagedPath))
            await rm(stagedPath, { force: true }).catch(() => undefined);
        }
      } finally {
        await source.close();
      }
    }
    return { directory, paths };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
function result(
  success: boolean,
  status: AddAudioSourceResult["status"],
  sourceCountBefore: number,
  sourceCountAfter: number,
  expectedSourceNames: string[],
  verifiedSourceNames: string[],
  files: AudioFileReceipt[],
  message?: string
): AddAudioSourceResult {
  return {
    success,
    status,
    sourceCountBefore,
    sourceCountAfter,
    expectedSourceNames,
    verifiedSourceNames,
    files,
    message,
  };
}
async function openOverlay(page: Page): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();
  if (await overlay.isVisible({ timeout: 500 }).catch(() => false)) return;
  for (const selector of Selectors.sources.addButton) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 700 }).catch(() => false)) {
      await button.click();
      if (await overlay.isVisible({ timeout: 8_000 }).catch(() => false)) return;
    }
  }
  throw new Error("Could not open NotebookLM Add source dialog.");
}
async function choose(
  page: Page,
  filePaths: string[],
  markUploadInitiated: () => void
): Promise<void> {
  assertNotebookLmUrl(page.url());
  const overlay = page.locator(Selectors.sources.overlayPane).first(),
    input = overlay.locator('input[type="file"]').first();
  if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
    markUploadInitiated();
    await input.setInputFiles(filePaths);
    return;
  }
  for (const selector of Selectors.sources.sourceTypeFile) {
    if (selector === 'input[type="file"]') continue;
    const button = overlay.locator(selector).first();
    if (await button.isVisible({ timeout: 700 }).catch(() => false)) {
      const chooser = page.waitForEvent("filechooser", { timeout: 8_000 });
      await Promise.all([chooser, button.click()]);
      assertNotebookLmUrl(page.url());
      markUploadInitiated();
      await (await chooser).setFiles(filePaths);
      return;
    }
  }
  throw new Error("Could not find NotebookLM file-upload control.");
}
async function visible(page: Page, names: string[]): Promise<string[]> {
  const rows = page.locator(Selectors.sources.sourceContainer);
  const verified: string[] = [];
  for (const name of names) {
    const expected = normaliseSourceName(name);
    const rowCount = await rows.count().catch(() => 0);
    let found = false;
    for (let index = 0; index < rowCount; index += 1) {
      // Match a dedicated descendant exactly.  The row itself often also
      // contains status text (for example “Processing”), so comparing its
      // full text would produce false negatives; substring matching would
      // produce false positives for near-identical filenames.
      const candidates = rows.nth(index).getByText(name, { exact: true });
      const candidateCount = await candidates.count().catch(() => 0);
      for (let candidate = 0; candidate < candidateCount; candidate += 1) {
        if (
          await candidates
            .nth(candidate)
            .isVisible()
            .catch(() => false)
        ) {
          const actual = normaliseSourceName(
            (await candidates
              .nth(candidate)
              .textContent()
              .catch(() => "")) ?? ""
          );
          if (actual === expected) {
            found = true;
            break;
          }
        }
      }
      if (found) break;
    }
    if (found) verified.push(name);
  }
  return verified;
}
async function assertMagic(file: string, extension: string): Promise<void> {
  const h = await open(file, "r");
  try {
    const b = Buffer.alloc(128);
    const { bytesRead } = await h.read(b, 0, b.length, 0);
    await assertMagicBuffer(b.subarray(0, bytesRead), extension, path.basename(file));
  } finally {
    await h.close();
  }
}
async function assertMagicBuffer(data: Buffer, extension: string, name: string): Promise<void> {
  const v = data.subarray(0, 128),
    mp3 = v.subarray(0, 3).toString() === "ID3" || (v[0] === 0xff && (v[1] & 0xe0) === 0xe0),
    wav = v.subarray(0, 4).toString() === "RIFF" && v.subarray(8, 12).toString() === "WAVE",
    flac = v.subarray(0, 4).toString() === "fLaC",
    ogg = v.subarray(0, 4).toString() === "OggS",
    opus = ogg && v.includes(Buffer.from("OpusHead")),
    m4a = v.subarray(4, 8).toString() === "ftyp",
    aac = v[0] === 0xff && (v[1] & 0xf6) === 0xf0;
  const ok =
    (extension === ".mp3" && mp3) ||
    (extension === ".wav" && wav) ||
    (extension === ".flac" && flac) ||
    (extension === ".ogg" && ogg) ||
    (extension === ".opus" && opus) ||
    (extension === ".m4a" && m4a) ||
    (extension === ".aac" && aac);
  if (!ok) throw new Error(`Audio signature does not match extension: ${name}.`);
}
function digest(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256"),
      stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (c: string | Buffer) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
