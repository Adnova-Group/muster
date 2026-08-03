import { validateAdviceRequest } from "../src/advisor.js";
import { renderPlanChecklist } from "../src/checklist.js";
import { envInt } from "../src/env-util.js";
import { scoreOutcomeForFastPath, buildFastPathManifest } from "../src/fast-path.js";
import { fuse } from "../src/fusion.js";
import { DEFAULT_REVIEW_DIFF_THRESHOLD, planGateCadence } from "../src/gate-cadence.js";
import { modelForRole } from "../src/model.js";
import { claudeModelForTier } from "../src/claude.js";
import { pickWinner } from "../src/tournament.js";
import { prioritize } from "../src/prioritize.js";
import { tallyReview, verdictsTallyCorruptionErrors } from "../src/review.js";
import { scoreArtifact } from "../src/score.js";
import { reconcileSprintProgress } from "../src/sprint-waves.js";
import { validateVerdicts } from "../src/verdict-schema.js";
import { computeWaves, nextTasks } from "../src/wave.js";
import { Worker } from "node:worker_threads";
import { verify as verifySignature } from "node:crypto";

const PURE_TOOLS = new Set([
  "muster_wave",
  "muster_next",
  "muster_gate_cadence",
  "muster_sprint_reconcile",
  "muster_score",
  "muster_prioritize",
  "muster_pick",
  "muster_tally",
  "muster_advise",
  "muster_fuse",
  "muster_fast_path",
  "muster_plan_checklist",
]);

const json = (value) => JSON.stringify(value, null, 2);
const workerUrl = new URL("./in-process-worker.mjs", import.meta.url);
const MAX_WORKER_OUTPUT_BYTES = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

const legacyCommaList = (values) => {
  const joined = values?.length ? values.join(",") : "";
  return joined ? joined.split(",") : [];
};

async function evaluate(name, args, environment, runtime = {}) {
  switch (name) {
    case "muster_wave": {
      if (!Array.isArray(args.manifest?.plan)) fail("wave: manifest has no 'plan' array");
      return { ok: true, text: json(computeWaves(args.manifest.plan)) };
    }
    case "muster_next": {
      if (!Array.isArray(args.manifest?.plan)) fail("next: manifest has no 'plan' array");
      return { ok: true, text: json(nextTasks(args.manifest.plan, legacyCommaList(args.completed))) };
    }
    case "muster_gate_cadence": {
      if (!Array.isArray(args.manifest?.plan)) fail("gate-cadence: manifest has no 'plan' array");
      const waves = computeWaves(args.manifest.plan).map((wave) => wave.map((task) => task.id));
      const changedLines = args.changedLines;
      if (changedLines !== undefined && (!Number.isFinite(changedLines) || changedLines < 0)) {
        fail("gate-cadence --changed-lines must be a non-negative finite number");
      }
      const reviewDiffThreshold = envInt(
        "MUSTER_REVIEW_DIFF_THRESHOLD",
        { min: 0, def: DEFAULT_REVIEW_DIFF_THRESHOLD },
        environment,
      );
      return {
        ok: true,
        text: json(planGateCadence(waves, changedLines === undefined ? {} : { changedLines, reviewDiffThreshold })),
      };
    }
    case "muster_sprint_reconcile": {
      const receiptPublicKey = environment.MUSTER_LIFECYCLE_RECEIPT_PUBLIC_KEY;
      const approvalPublicKey = environment.MUSTER_INTEGRATION_APPROVAL_PUBLIC_KEY;
      const result = reconcileSprintProgress(
        args.plan,
        {
          receipts: args.receipts,
          inFlight: args.inFlight,
          integrationTargets: args.integrationTargets,
          approvals: args.approvals,
          recovery: {
            ...(environment.MUSTER_RECOVERY_NO_PROGRESS_LIMIT === undefined ? {} : {
              noProgressLimit: Number(environment.MUSTER_RECOVERY_NO_PROGRESS_LIMIT),
            }),
            ...(environment.MUSTER_RECOVERY_MAX_CONTINUATIONS === undefined ? {} : {
              maxContinuations: Number(environment.MUSTER_RECOVERY_MAX_CONTINUATIONS),
            }),
          },
        },
        {
          environment,
          trustedRunId: environment.MUSTER_RUN_ID,
          verifyApproval: approval => {
            if (typeof approvalPublicKey !== "string" || !approvalPublicKey
              || typeof approval.evidence !== "string") return false;
            try {
              return verifySignature(null, Buffer.from(approval.digest, "hex"), approvalPublicKey,
                Buffer.from(approval.evidence, "base64"));
            } catch { return false; }
          },
          verifyReceipt: (receipt, digest) => {
            if (typeof receiptPublicKey !== "string" || !receiptPublicKey
              || typeof receipt.evidence !== "string") return false;
            try {
              return verifySignature(null, Buffer.from(digest, "hex"), receiptPublicKey,
                Buffer.from(receipt.evidence, "base64"));
            } catch { return false; }
          },
        },
      );
      return { ok: result.ok !== false, text: json(result) };
    }
    case "muster_score":
      return { ok: true, text: json(scoreArtifact(args.scores, args.gate)) };
    case "muster_prioritize":
      return { ok: true, text: json(prioritize(args.items, args.model || "rice")) };
    case "muster_pick":
      return { ok: true, text: json(pickWinner(args.candidates, { environment })) };
    case "muster_tally": {
      let validation;
      try {
        validation = await validateVerdicts(args.verdicts, runtime.verdictSchemaPath);
      } catch {
        fail("internal error: verdict schema unavailable");
      }
      if (!validation.ok) {
        const corrupt = verdictsTallyCorruptionErrors(args.verdicts);
        if (corrupt.length > 0) {
          fail(`tally <verdicts.json>: fails verdict.schema.json and is not tally-able:\n${[...corrupt, ...validation.errors].join("\n")}`);
        }
      }
      return { ok: true, text: json(tallyReview(args.verdicts)) };
    }
    case "muster_advise": {
      const validation = validateAdviceRequest(args.request);
      if (!validation.ok) fail(validation.errors.join("\n"));
      const advisorModel = modelForRole("advisor", environment);
      return {
        ok: true,
        text: json({ advisorModel, advisorClaudeModel: claudeModelForTier(advisorModel).model, request: args.request }),
      };
    }
    case "muster_fuse":
      return { ok: true, text: json(fuse(args.candidates, args.fusionMap, { environment })) };
    case "muster_fast_path": {
      if (typeof args.outcome !== "string" || !args.outcome.trim()) fail("muster_fast_path: outcome is required");
      const score = scoreOutcomeForFastPath(args.outcome);
      const result = score.eligible && args.capabilities != null
        ? { ...score, manifest: buildFastPathManifest({ outcome: args.outcome, capabilities: args.capabilities }) }
        : score;
      return { ok: true, text: json(result) };
    }
    case "muster_plan_checklist":
      return { ok: true, text: renderPlanChecklist(args.manifest?.plan || [], legacyCommaList(args.done)) };
    default:
      return null;
  }
}

export async function evaluateInProcessTool(name, args, environment = process.env, runtime = {}) {
  try {
    const result = await evaluate(name, args, environment, runtime);
    return result;
  } catch (error) {
    const detail = environment.DEBUG ? (error.stack || error.message) : error.message;
    return { ok: false, text: `muster: ${detail}` };
  }
}

export async function invokeInProcessTool(name, args, { signal, environment = process.env } = {}) {
  if (!PURE_TOOLS.has(name)) return { handled: false };
  if (signal?.aborted) return { handled: true, result: { ok: false, text: "muster MCP request cancelled" } };

  return new Promise((resolve) => {
    const worker = new Worker(workerUrl, {
      workerData: { name, args, environment },
      env: environment,
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await worker.terminate().catch(() => {});
      resolve({ handled: true, result });
    };
    const abort = () => void finish({ ok: false, text: "muster MCP request cancelled" });
    const timer = setTimeout(
      () => void finish({ ok: false, text: "muster MCP request timed out after 60000ms" }),
      60_000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (result) => {
      const valid = result && typeof result === "object" && typeof result.ok === "boolean" && typeof result.text === "string";
      if (!valid) {
        void finish({ ok: false, text: "internal error: in-process MCP worker returned an invalid result" });
      } else if (Buffer.byteLength(result.text) > MAX_WORKER_OUTPUT_BYTES) {
        void finish({ ok: false, text: `muster MCP worker output exceeded ${MAX_WORKER_OUTPUT_BYTES} byte limit` });
      } else {
        void finish(result);
      }
    });
    worker.once("error", () => void finish({ ok: false, text: "internal error: in-process MCP worker failed" }));
    worker.once("exit", () => {
      if (!settled) void finish({ ok: false, text: "internal error: in-process MCP worker failed" });
    });
  });
}

export const IN_PROCESS_TOOL_NAMES = Object.freeze([...PURE_TOOLS]);
