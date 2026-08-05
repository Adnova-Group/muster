// codex-install-config-transactions.js -- config candidate publish/rollback
// and retirement-artifact bookkeeping, split out of codex-install.js
// (split-codex-install). Depends only on node builtins, fs-util.js, and
// codex-install-shared.js.
import { constants as fsConstants } from "node:fs";
import { open, readdir, rename, unlink, link } from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readdirSafe } from "./fs-util.js";
import { ordinaryDirectoryPath, snapshot, exactFileSnapshot, sameExactFileSnapshot } from "./codex-install-shared.js";

export function concurrentConfigError(message) {
  const error = new Error(message);
  error.musterConcurrentConfig = true;
  return error;
}


const retirementReceiptDir = configPath => join(dirname(configPath), "muster", "config-retirements");

const retirementArtifactPrefix = configPath => `.${basename(configPath)}.muster-retired-`;


function retirementArtifactRecord(configPath, artifactPath, snapshot) {
  return {
    configPath,
    artifactPath,
    dev: String(snapshot.dev),
    ino: String(snapshot.ino),
    size: snapshot.bytes.length,
    algorithm: "sha256",
    digest: createHash("sha256").update(snapshot.bytes).digest("hex")
  };
}


async function readConfigRetirementState(configPath, pendingArtifacts = new Set()) {
  const path = retirementReceiptDir(configPath);
  const entries = [];
  if (await ordinaryDirectoryPath(path)) {
    for (const name of await readdir(path)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error(`Codex config retirement receipt conflict: ${join(path, name)}`);
      const receiptPath = join(path, name);
      const receiptSnapshot = await exactFileSnapshot(receiptPath);
      let entry;
      try { entry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptSnapshot.bytes)); }
      catch { entry = null; }
      const artifactName = typeof entry?.artifactPath === "string" ? basename(entry.artifactPath) : "";
      const structurallyValid = entry?.configPath === configPath
        && dirname(entry.artifactPath || "") === dirname(configPath)
        && artifactName.startsWith(retirementArtifactPrefix(configPath))
        && name === `${createHash("sha256").update(entry.artifactPath).digest("hex")}.json`
        && typeof entry.dev === "string" && /^\d+$/.test(entry.dev)
        && typeof entry.ino === "string" && /^\d+$/.test(entry.ino)
        && Number.isSafeInteger(entry.size) && entry.size >= 0
        && entry.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(entry.digest);
      if (!structurallyValid) throw new Error(`Codex config retirement receipt conflict: ${receiptPath}`);
      const snapshot = await exactFileSnapshot(entry.artifactPath);
      const actual = snapshot.exists ? retirementArtifactRecord(configPath, entry.artifactPath, snapshot) : null;
      if (!actual || JSON.stringify(actual) !== JSON.stringify(entry)) {
        throw new Error(`Codex config retired baseline changed: ${entry.artifactPath}. Preserve and inspect it before rerunning the command.`);
      }
      entries.push(entry);
    }
  }
  const receipted = new Set(entries.map(entry => entry.artifactPath));
  const artifacts = (await readdirSafe(dirname(configPath))).filter(name => name.startsWith(retirementArtifactPrefix(configPath)))
    .map(name => join(dirname(configPath), name));
  for (const artifact of artifacts) {
    if (!receipted.has(artifact) && !pendingArtifacts.has(artifact)) {
      throw new Error(`Codex config retirement artifact has no receipt: ${artifact}. Preserve and inspect it before rerunning the command.`);
    }
  }
  if (new Set(entries.map(entry => entry.artifactPath)).size !== entries.length) {
    throw new Error(`Codex config retirement receipt conflict: duplicate artifact entry under ${path}`);
  }
  return { path, entries, artifacts };
}


export async function verifyCodexConfigRetirementReceipt(configPath) {
  return readConfigRetirementState(configPath);
}


export async function retainConfigArtifacts(configPath, artifactPaths) {
  const pending = new Set(artifactPaths.filter(Boolean));
  const state = await readConfigRetirementState(configPath, pending);
  await ordinaryDirectoryPath(state.path, { create: true });
  for (const artifactPath of pending) {
    if (state.entries.some(entry => entry.artifactPath === artifactPath)) continue;
    const snapshot = await exactFileSnapshot(artifactPath);
    if (!snapshot.exists) continue;
    const entry = retirementArtifactRecord(configPath, artifactPath, snapshot);
    const receiptPath = join(state.path, `${createHash("sha256").update(artifactPath).digest("hex")}.json`);
    const staged = await writePrivateSibling(receiptPath, "retirement-receipt", Buffer.from(JSON.stringify(entry, null, 2) + "\n"));
    try { await link(staged, receiptPath); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    finally { await unlink(staged).catch(() => {}); }
  }
  await readConfigRetirementState(configPath);
}


async function writePrivateSibling(path, label, bytes) {
  const privatePath = join(dirname(path), `.${basename(path)}.muster-${label}-${process.pid}-${randomUUID()}`);
  const handle = await open(privatePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return privatePath;
}


async function restoreRetiredName(path, retired) {
  try { await link(retired, path); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}


async function promoteChangedDisplaced(path, displaced, expectedDisplaced, restoredBaseline) {
  if (!restoredBaseline || sameExactFileSnapshot(expectedDisplaced, await exactFileSnapshot(displaced))) return;
  const live = await exactFileSnapshot(path);
  if (!sameExactFileSnapshot(restoredBaseline, live)) return;
  const baselineAlias = live.exists
    ? join(dirname(path), `.${basename(path)}.muster-displaced-baseline-${process.pid}-${randomUUID()}`)
    : null;
  if (baselineAlias) {
    await rename(path, baselineAlias);
    if (!sameExactFileSnapshot(restoredBaseline, await exactFileSnapshot(baselineAlias))) {
      await restoreRetiredName(path, baselineAlias);
      await unlink(baselineAlias);
      return;
    }
  }
  try { await link(displaced, path); }
  catch (error) {
    if (error.code !== "EEXIST") {
      if (baselineAlias) await restoreRetiredName(path, baselineAlias);
      throw error;
    }
  }
  if (baselineAlias) await unlink(baselineAlias);
}

// Publish without an overwrite-capable rename. The old name is first retired,
// checked by inode and bytes, then the candidate is hard-linked into the now
// vacant name with EEXIST semantics. A concurrent creator therefore wins.

export async function publishConfigCandidate(path, expected, bytes) {
  await ordinaryDirectoryPath(dirname(path), { create: true });
  const staged = await writePrivateSibling(path, "candidate", bytes);
  const stagedSnapshot = await exactFileSnapshot(staged);
  const recovery = expected.exists ? await writePrivateSibling(path, "publication-recovery", expected.bytes) : null;
  const recoverySnapshot = recovery ? await exactFileSnapshot(recovery) : { exists: false, bytes: null, dev: null, ino: null };
  let retired = null;
  try {
    if (expected.exists) {
      retired = join(dirname(path), `.${basename(path)}.muster-retired-${process.pid}-${randomUUID()}`);
      await rename(path, retired);
      if (!sameExactFileSnapshot(expected, await exactFileSnapshot(retired))) {
        await restoreRetiredName(path, retired);
        throw concurrentConfigError(`Codex config changed before strict candidate publication: ${path}; concurrent bytes were preserved`);
      }
    }
    try { await link(staged, path); }
    catch (error) {
      if (retired) await restoreRetiredName(path, retired);
      if (error.code === "EEXIST") throw concurrentConfigError(`Codex config changed during strict candidate publication: ${path}; concurrent bytes were preserved`);
      throw error;
    }
    const published = await exactFileSnapshot(path);
    if (!sameExactFileSnapshot(stagedSnapshot, published)) {
      throw concurrentConfigError(`Codex config changed during strict candidate publication: ${path}; concurrent bytes were preserved`);
    }
    if (retired && !sameExactFileSnapshot(expected, await exactFileSnapshot(retired))) {
      throw concurrentConfigError(`Codex config changed during strict candidate publication: ${path}; concurrent bytes were preserved`);
    }
    return { path, expected, retired, published: stagedSnapshot };
  } catch (error) {
    // Recover from retained bytes, not from the retirement pathname. If a
    // concurrent writer owns the live name, preserve it. If our candidate is
    // live, retire it first and restore the exact baseline exclusively.
    let current;
    try { current = await exactFileSnapshot(path); }
    catch { current = { exists: false, bytes: null, dev: null, ino: null }; }
    let displaced = null;
    let restoredBaseline = expected.exists ? null : { exists: false, bytes: null, dev: null, ino: null };
    if (sameExactFileSnapshot(stagedSnapshot, current)) {
      displaced = join(dirname(path), `.${basename(path)}.muster-retired-failed-publication-${process.pid}-${randomUUID()}`);
      await rename(path, displaced);
      const moved = await exactFileSnapshot(displaced);
      if (sameExactFileSnapshot(stagedSnapshot, moved)) {
        current = { exists: false, bytes: null, dev: null, ino: null };
      } else {
        // A writer won between the live snapshot and rename. Re-link exactly
        // what was moved; never replace it with the retained baseline.
        await restoreRetiredName(path, displaced);
        current = await exactFileSnapshot(path);
      }
    }
    if (!current.exists && expected.exists) {
      let restored = false;
      if (retired) {
        try {
          await link(retired, path);
          restored = true;
          restoredBaseline = await exactFileSnapshot(retired);
        }
        catch (restoreError) {
          if (restoreError.code === "EEXIST") restored = true;
          else if (restoreError.code !== "ENOENT") {
            if (displaced) await restoreRetiredName(path, displaced);
            throw restoreError;
          }
        }
      }
      if (!restored && recovery) {
        try {
          await link(recovery, path);
          restoredBaseline = recoverySnapshot;
        }
        catch (restoreError) {
          if (restoreError.code !== "EEXIST") {
            if (displaced) await restoreRetiredName(path, displaced);
            throw restoreError;
          }
        }
      }
    }
    if (displaced) await promoteChangedDisplaced(path, displaced, stagedSnapshot, restoredBaseline);
    await retainConfigArtifacts(path, [displaced, retired]);
    throw error;
  } finally {
    try { await unlink(staged); } catch { /* best-effort private-artifact cleanup */ }
    if (recovery) try { await unlink(recovery); } catch { /* best-effort private-artifact cleanup */ }
  }
}


export async function rollbackConfigCandidate(receipt) {
  const { path, expected, retired, published } = receipt;
  const current = await exactFileSnapshot(path);
  if (!sameExactFileSnapshot(published, current)) {
    if (retired) await retainConfigArtifacts(path, [retired]);
    return;
  }
  // Materialize the byte-exact baseline before moving the live candidate.
  // Rollback never depends on the path-addressable retirement artifact still
  // existing: cleanup, antivirus, or a concurrent actor may have removed it.
  const recovery = expected.exists ? await writePrivateSibling(path, "recovery", expected.bytes) : null;
  const displaced = join(dirname(path), `.${basename(path)}.muster-retired-rollback-${process.pid}-${randomUUID()}`);
  let discardDisplaced = false;
  let moved = false;
  let restoredBaseline = expected.exists ? null : { exists: false, bytes: null, dev: null, ino: null };
  try {
    await rename(path, displaced);
    moved = true;
    if (!sameExactFileSnapshot(published, await exactFileSnapshot(displaced))) {
      await restoreRetiredName(path, displaced);
      discardDisplaced = true;
      return;
    }
    if (expected.exists) {
      let restored = false;
      if (retired) {
        try {
          await link(retired, path);
          restored = true;
          restoredBaseline = await exactFileSnapshot(retired);
        }
        catch (error) {
          if (error.code === "EEXIST") restored = true;
          else if (error.code !== "ENOENT") throw error;
        }
      }
      if (!restored && recovery) {
        try {
          await link(recovery, path);
          restoredBaseline = await exactFileSnapshot(recovery);
        }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
    }
    // For an originally absent file, the vacant name is the restored state.
    // For an existing file, either recovery won or a concurrent creator did.
    discardDisplaced = true;
  } catch (error) {
    // Never leave the live name missing merely because recovery failed.
    if (moved) await restoreRetiredName(path, displaced);
    throw error;
  } finally {
    if (discardDisplaced) await promoteChangedDisplaced(path, displaced, published, restoredBaseline);
    await retainConfigArtifacts(path, [discardDisplaced ? displaced : null, retired]);
    if (recovery) try { await unlink(recovery); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
