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

function fail(message) {
  throw new Error(message);
}

async function evaluate(name, args, environment) {
  switch (name) {
    case "muster_wave": {
      if (!Array.isArray(args.manifest?.plan)) fail("wave: manifest has no 'plan' array");
      return { ok: true, text: json(computeWaves(args.manifest.plan)) };
    }
    case "muster_next": {
      if (!Array.isArray(args.manifest?.plan)) fail("next: manifest has no 'plan' array");
      return { ok: true, text: json(nextTasks(args.manifest.plan, args.completed || [])) };
    }
    case "muster_gate_cadence": {
      if (!Array.isArray(args.manifest?.plan)) fail("gate-cadence: manifest has no 'plan' array");
      const waves = computeWaves(args.manifest.plan).map((wave) => wave.map((task) => task.id));
      const changedLines = args.changedLines;
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
      const result = reconcileSprintProgress(args.plan, { receipts: args.receipts, inFlight: args.inFlight });
      return { ok: result.ok !== false, text: json(result) };
    }
    case "muster_score":
      return { ok: true, text: json(scoreArtifact(args.scores, args.gate)) };
    case "muster_prioritize":
      return { ok: true, text: json(prioritize(args.items, args.model || "rice")) };
    case "muster_pick":
      return { ok: true, text: json(pickWinner(args.candidates)) };
    case "muster_tally": {
      const validation = await validateVerdicts(args.verdicts);
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
      return { ok: true, text: json(fuse(args.candidates, args.fusionMap)) };
    case "muster_fast_path": {
      if (typeof args.outcome !== "string" || !args.outcome.trim()) fail("muster_fast_path: outcome is required");
      const score = scoreOutcomeForFastPath(args.outcome);
      const result = score.eligible && args.capabilities != null
        ? { ...score, manifest: buildFastPathManifest({ outcome: args.outcome, capabilities: args.capabilities }) }
        : score;
      return { ok: true, text: json(result) };
    }
    case "muster_plan_checklist":
      return { ok: true, text: renderPlanChecklist(args.manifest?.plan || [], args.done || []) };
    default:
      return null;
  }
}

export async function invokeInProcessTool(name, args, { signal, environment = process.env } = {}) {
  if (!PURE_TOOLS.has(name)) return { handled: false };

  // Yield once before synchronous work so an immediately-following MCP cancellation
  // notification can abort this request just as it could abort the former CLI child.
  await new Promise((resolve) => setImmediate(resolve));
  if (signal?.aborted) return { handled: true, result: { ok: false, text: "muster MCP request cancelled" } };

  try {
    const result = await evaluate(name, args, environment);
    if (signal?.aborted) return { handled: true, result: { ok: false, text: "muster MCP request cancelled" } };
    return { handled: true, result };
  } catch (error) {
    if (signal?.aborted) return { handled: true, result: { ok: false, text: "muster MCP request cancelled" } };
    const detail = environment.DEBUG ? (error.stack || error.message) : error.message;
    return { handled: true, result: { ok: false, text: `muster: ${detail}` } };
  }
}

export const IN_PROCESS_TOOL_NAMES = Object.freeze([...PURE_TOOLS]);
