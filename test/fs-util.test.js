import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dirFromImportMeta } from "../src/fs-util.js";

// dirFromImportMeta(importMetaUrl, rel) must:
//   1. return an absolute path (no leading-slash-drive artifact like /C:/...)
//   2. equal what fileURLToPath(new URL(rel, importMetaUrl)) would return
//   3. actually exist as a directory when called with a known relative path

test("dirFromImportMeta returns an absolute path", () => {
  const result = dirFromImportMeta(import.meta.url, "./");
  assert.ok(path.isAbsolute(result), `expected absolute path, got: ${result}`);
});

test("dirFromImportMeta equals fileURLToPath equivalent", () => {
  const rel = "../";
  const expected = fileURLToPath(new URL(rel, import.meta.url));
  const result = dirFromImportMeta(import.meta.url, rel);
  assert.equal(result, expected);
});

test("dirFromImportMeta does not contain leading-slash-drive artifact", () => {
  // On Windows a bare .pathname gives /C:/... — fileURLToPath normalises it to C:\...
  // On Linux this is a no-op check but the assertion is honest on both platforms.
  const result = dirFromImportMeta(import.meta.url, "../");
  assert.ok(
    !/^\/[A-Za-z]:/.test(result),
    `result must not start with /DRIVE: — got: ${result}`
  );
});
