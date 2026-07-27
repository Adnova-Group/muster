import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildCodexReviewShadowCall,
  parseCodexReviewJsonl,
  scoreCodexReviewShadow,
  validateShadowVerdict,
} from "../../src/codex-review-shadow.js";

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const corpusPath = join(here, "corpus.json");
const schemaPath = join(here, "verdict.schema.json");
const resultsPath = join(here, "results.json");
const model = process.env.MUSTER_SHADOW_REVIEW_MODEL || "gpt-5.6-terra";
const CURRENT_REVIEW_SKILL_TOKENS = 1818;
const CURRENT_REVIEW_OUTPUT_TOKENS = 300;
const CURRENT_REVIEW_DIFF_TOKEN_CAP = 2000;

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

async function git(args, options = {}) {
  return execFile("git", args, { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024, ...options });
}

async function currentReviewTokens(commit) {
  const { stdout } = await git(["show", "--format=", "--no-ext-diff", "--unified=3", commit]);
  return CURRENT_REVIEW_SKILL_TOKENS
    + Math.min(estimateTokens(stdout), CURRENT_REVIEW_DIFF_TOKEN_CAP)
    + CURRENT_REVIEW_OUTPUT_TOKENS;
}

async function reviewCase(entry, tempRoot) {
  const caseRoot = join(tempRoot, entry.id);
  const lastMessagePath = join(tempRoot, `${entry.id}.last.json`);
  await git(["worktree", "add", "--detach", caseRoot, entry.commit]);
  try {
    await symlink(join(repoRoot, "node_modules"), join(caseRoot, "node_modules"), "dir");
    const call = buildCodexReviewShadowCall({
      commit: entry.commit,
      schemaPath,
      lastMessagePath,
      model,
    });
    const startedAt = Date.now();
    const { stdout } = await execFile(call.command, call.argv, {
      cwd: caseRoot,
      maxBuffer: 30 * 1024 * 1024,
    });
    const parsed = parseCodexReviewJsonl(stdout);
    if (!parsed.verdict) {
      try {
        const lastMessageText = await readFile(lastMessagePath, "utf8");
        parsed.rawAgentMessage ||= lastMessageText;
        parsed.verdict = JSON.parse(lastMessageText);
      } catch {
        // validateShadowVerdict records the absent/malformed output.
      }
    }
    const validation = validateShadowVerdict(parsed.verdict);
    return {
      id: entry.id,
      commit: entry.commit,
      fixCommit: entry.fixCommit,
      durationMs: Date.now() - startedAt,
      schemaValid: validation.ok,
      schemaErrors: validation.errors,
      verdict: parsed.verdict,
      usage: parsed.usage,
      rawAgentMessage: parsed.rawAgentMessage,
      diagnosticEvents: parsed.diagnosticEvents,
    };
  } catch (error) {
    const parsed = parseCodexReviewJsonl(error.stdout);
    try {
      const lastMessageText = await readFile(lastMessagePath, "utf8");
      parsed.rawAgentMessage ||= lastMessageText;
      parsed.verdict ||= JSON.parse(lastMessageText);
    } catch {
      // Preserve the rejected process diagnostics even without a last message.
    }
    const validation = validateShadowVerdict(parsed.verdict);
    return {
      id: entry.id,
      commit: entry.commit,
      fixCommit: entry.fixCommit,
      schemaValid: false,
      schemaErrors: [
        ...validation.errors,
        String(error.stderr || error.message || error),
      ],
      verdict: parsed.verdict,
      usage: parsed.usage,
      rawAgentMessage: parsed.rawAgentMessage,
      diagnosticEvents: parsed.diagnosticEvents,
      rejectedProcessStdout: String(error.stdout ?? ""),
    };
  } finally {
    await git(["worktree", "remove", "--force", caseRoot]).catch(() => {});
  }
}

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
if (corpus.length < 10) throw new Error(`corpus must contain at least 10 cases; got ${corpus.length}`);
const enrichedCorpus = [];
for (const entry of corpus) {
  await git(["cat-file", "-e", `${entry.commit}^{commit}`]);
  await git(["cat-file", "-e", `${entry.fixCommit}^{commit}`]);
  enrichedCorpus.push({ ...entry, currentReviewTokens: await currentReviewTokens(entry.commit) });
}
const harnessSourceFiles = [
  "src/codex-review-shadow.js",
  "test/codex-review-shadow.test.js",
  "eval/codex-review-shadow/run.mjs",
  "eval/codex-review-shadow/verdict.schema.json",
  "eval/codex-review-shadow/corpus.json",
];
const harnessSourceHash = createHash("sha256");
for (const path of harnessSourceFiles) {
  harnessSourceHash.update(`${path}\0`);
  harnessSourceHash.update(await readFile(join(repoRoot, path)));
  harnessSourceHash.update("\0");
}
const [{ stdout: codexVersion }, { stdout: harnessHead }, { stdout: harnessStatus }] = await Promise.all([
  execFile("codex", ["--version"]),
  git(["rev-parse", "HEAD"]),
  git(["status", "--short"]),
]);

const tempRoot = await mkdtemp(join(tmpdir(), "muster-codex-review-shadow-"));
const runs = [];
try {
  for (const [index, entry] of enrichedCorpus.entries()) {
    console.log(`[${index + 1}/${enrichedCorpus.length}] ${entry.id}`);
    const run = await reviewCase(entry, tempRoot);
    runs.push(run);
    console.log(`  schema=${run.schemaValid ? "valid" : "INVALID"} verdict=${run.verdict?.verdict ?? "none"} tokens=${run.usage?.totalTokens ?? "unknown"} durationMs=${run.durationMs ?? "unknown"}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  await git(["worktree", "prune"]);
}

const summary = scoreCodexReviewShadow(enrichedCorpus, runs);
const report = {
  generatedAt: new Date().toISOString(),
  mode: "shadow-only",
  productionRoutingChanged: false,
  commandSurface: "codex exec review --json --output-schema",
  model,
  environment: {
    codexVersion: codexVersion.trim(),
    harnessHead: harnessHead.trim(),
    harnessDirty: Boolean(harnessStatus.trim()),
    harnessSourceDigest: `sha256:${harnessSourceHash.digest("hex")}`,
    harnessSourceFiles,
  },
  currentReviewTokenBaseline: {
    kind: "modeled",
    unit: "one current Muster reviewer (conservative denominator when live cadence selects multiple reviewers)",
    formula: "1818 full review-gate skill tokens + min(diff chars / 4, 2000) + 300 output tokens",
    source: "docs/fast-path-token-gap.md",
  },
  thresholdTokenMetric: "turn.completed usage.input_tokens + usage.output_tokens",
  summary,
  corpus: enrichedCorpus,
  runs,
  conclusion: summary.acceptancePassed
    ? "All shadow acceptance thresholds passed; evidence is eligible for a separate routing proposal, but this benchmark makes no production change."
    : "Shadow acceptance thresholds did not all pass; do not propose or make a production routing change.",
};
await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.acceptancePassed ? 0 : 2;
