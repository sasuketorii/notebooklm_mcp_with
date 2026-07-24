import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  exactVisibleNames,
  classifyUploadError,
  resolveUploadTimeout,
  stageValidatedFiles,
  validateAudioFiles,
} from "../dist/notebooklm/audio-upload.js";
import { assertNotebookLmUrl } from "../dist/notebooklm/notebook-url.js";
const root = await mkdtemp(path.join(os.tmpdir(), "notebooklm-audio-root-"));
const outside = await mkdtemp(path.join(os.tmpdir(), "notebooklm-audio-outside-"));
process.env.NOTEBOOKLM_AUDIO_ROOTS = root;
try {
  const mp3 = path.join(root, "sample.mp3"),
    fake = path.join(root, "fake.mp3"),
    alias = path.join(root, "alias.mp3"),
    duplicate = path.join(root, "sample-copy.mp3"),
    escape = path.join(root, "escape.mp3"),
    zero = path.join(root, "zero.mp3"),
    oversized = path.join(root, "oversized.mp3"),
    outsideFile = path.join(outside, "outside.mp3"),
    nestedA = path.join(root, "a"),
    nestedB = path.join(root, "b");
  await writeFile(mp3, Buffer.from([0x49, 0x44, 0x33, 0x04]));
  await writeFile(fake, "not audio");
  await writeFile(duplicate, Buffer.from([0x49, 0x44, 0x33, 0x03]));
  await symlink(mp3, alias);
  await writeFile(outsideFile, Buffer.from([0x49, 0x44, 0x33, 0x04]));
  await symlink(outsideFile, escape);
  await writeFile(zero, Buffer.alloc(0));
  await writeFile(oversized, Buffer.from([0x49, 0x44, 0x33, 0x04]));
  await truncate(oversized, 200 * 1024 * 1024 + 1);
  await mkdir(nestedA);
  await mkdir(nestedB);
  await writeFile(path.join(nestedA, "Foo.mp3"), Buffer.from([0x49, 0x44, 0x33, 0x04]));
  await writeFile(path.join(nestedB, "foo.mp3"), Buffer.from([0x49, 0x44, 0x33, 0x04]));
  const valid = await validateAudioFiles([mp3]);
  assert.equal(valid.receipts[0].name, "sample.mp3");
  assert.equal("path" in valid.receipts[0], false);
  const moved = path.join(root, "sample-original.mp3");
  await writeFile(moved, await readFile(mp3));
  await rm(mp3);
  await symlink(outsideFile, mp3);
  await assert.rejects(
    () => stageValidatedFiles(valid.canonicalPaths, valid.receipts),
    /ELOOP|changed after validation|too many symbolic links/
  );
  await rm(mp3);
  await writeFile(mp3, Buffer.from([0x49, 0x44, 0x33, 0x04]));
  const staged = await stageValidatedFiles([mp3], valid.receipts);
  assert.equal(path.basename(staged.paths[0]), "sample.mp3");
  assert.equal((await stat(staged.paths[0])).mode & 0o777, 0o600);
  await rm(staged.directory, { recursive: true, force: true });
  await rm(moved, { force: true });
  await assert.rejects(() => validateAudioFiles([fake]), /signature/);
  await assert.rejects(() => validateAudioFiles([mp3, alias]), /Duplicate/);
  await assert.rejects(() => validateAudioFiles([outsideFile]), /outside NOTEBOOKLM_AUDIO_ROOTS/);
  await assert.rejects(() => validateAudioFiles([escape]), /outside NOTEBOOKLM_AUDIO_ROOTS/);
  await assert.rejects(() => validateAudioFiles([zero]), /empty/);
  await assert.rejects(() => validateAudioFiles([oversized]), /per-file limit/);
  await assert.rejects(
    () => validateAudioFiles([path.join(nestedA, "Foo.mp3"), path.join(nestedB, "foo.mp3")]),
    /Duplicate audio filename/
  );
  await assert.rejects(() => validateAudioFiles(Array(11).fill(mp3)), /At most 10/);
  assert.deepEqual(exactVisibleNames(["sample.mp3", "sample.mp3 extra"], ["sample.mp3"]), [
    "sample.mp3",
  ]);
  assert.deepEqual(
    exactVisibleNames(["sample.mp3x", "sample.mp3 (Processing)"], ["sample.mp3"]),
    []
  );
  assert.throws(() => resolveUploadTimeout(1));
  assert.equal(resolveUploadTimeout(30_000), 30_000);
  assert.equal(classifyUploadError(false), "FAILED");
  assert.equal(classifyUploadError(true), "INDETERMINATE");
  for (const value of [
    "http://notebooklm.google.com/notebook/12345678-1234-1234-1234-123456789012",
    "https://evilnotebooklm.google.com/notebook/12345678-1234-1234-1234-123456789012",
    "https://user:pass@notebooklm.google.com/notebook/12345678-1234-1234-1234-123456789012",
    "https://notebooklm.google.com:444/notebook/12345678-1234-1234-1234-123456789012",
    "https://notebooklm.google.com/other",
  ])
    assert.throws(() => assertNotebookLmUrl(value));
  assert.match(
    assertNotebookLmUrl(
      "https://notebooklm.google.com/notebook/12345678-1234-1234-1234-123456789012"
    ),
    /^https:/
  );
  console.log("audio validation tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
