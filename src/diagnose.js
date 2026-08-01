import { createHash } from "node:crypto";
import { collectRecommendations, makeStage } from "./crew.js";

const CI_PATTERNS = [/\bFAIL\b/, /✗/, /Error:/, /\bassert/i, /exit code [1-9]/, /\bat .+:\d+/];
export const DIAGNOSTIC_CONTENT_MAX_BYTES = 64 * 1024;

function diagnosticIdentity(input) {
  const bytes = Buffer.byteLength(input, "utf8");
  return {
    content: bytes <= DIAGNOSTIC_CONTENT_MAX_BYTES ? input : null,
    length: input.length,
    bytes,
    sha256: createHash("sha256").update(input, "utf8").digest("hex"),
    truncated: bytes > DIAGNOSTIC_CONTENT_MAX_BYTES
  };
}

export function classifyFailure(input, opts = {}) {
  if (!input || !input.trim()) throw new Error("diagnose: empty failure input");
  const isCi = !!opts.ci || CI_PATTERNS.some(re => re.test(input));
  const firstLine = input.split("\n").map(s => s.trim()).filter(Boolean)[0] || input.trim();
  return {
    mode: isCi ? "ci" : "bug",
    signal: firstLine.slice(0, 200),
    diagnostic: diagnosticIdentity(input)
  };
}

export function buildDiagnoseManifest(failure, caps = {}) {
  const stage = makeStage(caps, `failure: ${failure.signal}`);
  const recs = collectRecommendations(caps, ["debug", "implement", "test-author", "code-review"]);
  return {
    outcome: `Resolve: ${failure.signal}`,
    successCriteria: ["root cause identified", "fix applied", "regression test added", "suite green"],
    crew: [
      stage("debug", "systematic root-cause analysis"),
      stage("implement", "apply the minimal fix"),
      stage("test-author", "add a regression test"),
      stage("code-review", "review + verify the suite")
    ],
    recommendations: recs,
    degradations: [],
    plan: [
      {
        id: "repro",
        task: `reproduce: ${failure.signal}`,
        mode: "single",
        deps: [],
        diagnostic: failure.diagnostic
      },
      { id: "root-cause", task: "find root cause (hypothesis -> cheapest test -> root cause)", mode: "single", deps: ["repro"] },
      { id: "fix", task: "apply the minimal fix", mode: "single", deps: ["root-cause"] },
      { id: "regression", task: "add a regression test", mode: "single", deps: ["fix"] },
      { id: "verify", task: "review + run the suite", mode: "single", deps: ["regression"] }
    ]
  };
}
