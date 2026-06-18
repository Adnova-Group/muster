// Empirical eval pipeline: dataset -> {{VARIABLE}} interpolation -> LLM responses ->
// code-based + model-based graders -> floor-principle scoring -> report.
//
// The model is injected as `callModel(prompt) -> Promise<string>` so the pipeline is
// pure orchestration and fully testable offline. A promptfoo adapter can satisfy the
// same `callModel`/grader contract without changing this file. Deterministic graders
// (JSON/regex/format) run in-process at zero cost; the model grader is the fallback
// for subjective quality, in the cost order code >> model >> human.

export function interpolate(template, vars = {}) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m);
}

// --- Code-based graders: return 10 (valid) | 0 (invalid) | null (not applicable). ---
function validateJson(s) { try { JSON.parse(s); return 10; } catch { return 0; } }
// Cap pattern length before compiling an untrusted string (suite files / LLM output)
// so a pathological pattern cannot stall the regex compiler. The compiled RegExp is
// discarded immediately and never executed, so there is no exec-time ReDoS exposure.
function validateRegex(s) {
  if (typeof s !== "string" || s.length > 4096) return 0;
  try { new RegExp(s); return 10; } catch { return 0; }
}
// No Python runtime in-process: balanced-delimiter + a Python-signal heuristic so plain
// prose / SQL / JSON does not score as valid Python. Honest about being best-effort — a
// real run can shell out to `python -c` if available. (A lone `#` comment is NOT a
// signal: a markdown heading "# Title" would otherwise read as Python.)
const PY_SIGNAL = /\b(def|class|import|from|return|for|while|if|elif|else|with|lambda|print|yield|async|await)\b|:\s*\n\s+\S/;
function validatePython(s) {
  const t = String(s).trim();
  if (!t) return 0;
  const balanced = (open, close) =>
    (t.split(open).length - 1) === (t.split(close).length - 1);
  const delimitersOk = balanced("(", ")") && balanced("[", "]") && balanced("{", "}");
  return delimitersOk && PY_SIGNAL.test(t) ? 10 : 0;
}

const CODE_GRADERS = { json: validateJson, regex: validateRegex, python: validatePython };

export function codeGrade(output, format) {
  if (!format) return null;
  const grader = CODE_GRADERS[String(format).toLowerCase()];
  return grader ? grader(String(output)) : null;
}

// --- Model-based grader (LLM-as-judge). Ask for reasoning before the score so the ---
// model does not anchor on a default middling number.
export function buildGraderPrompt(output, rubric) {
  return [
    "You are a strict grader. Evaluate the assistant output against the rubric.",
    "",
    "<rubric>", rubric || "Judge overall quality and instruction-following.", "</rubric>",
    "",
    "<output>", output, "</output>",
    "",
    "Give concrete strengths and weaknesses, then a single integer score 0-10 (10 best).",
    "Respond ONLY with JSON:",
    '{"strengths": "...", "weaknesses": "...", "reasoning": "...", "score": <0-10>}',
  ].join("\n");
}

export function parseGraderResponse(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced ? fenced[1] : text;
  let obj = {};
  try { obj = JSON.parse(raw.trim()); }
  catch {
    const m = /"?score"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(text);
    obj = { score: m ? Number(m[1]) : 0, reasoning: "unparseable grader response" };
  }
  const score = Math.max(0, Math.min(10, Number(obj.score) || 0));
  return { score, reasoning: obj.reasoning || "", strengths: obj.strengths || "", weaknesses: obj.weaknesses || "" };
}

// Single source of truth for the grading policy: average code + model when both apply
// (correctness + technical validity), otherwise whichever is present, else 0.
function combineScores(code, model) {
  if (code != null && model != null) return (code + model) / 2;
  return code ?? model ?? 0;
}

async function gradeOne({ testCase, output, callModel, rubric }) {
  const code = codeGrade(output, testCase.format);
  const graderText = await callModel(buildGraderPrompt(output, rubric || testCase.rubric));
  const model = parseGraderResponse(graderText);
  const score = combineScores(code, model.score);
  return { codeScore: code, modelScore: model.score, score, reasoning: model.reasoning };
}

// Suite-level report shared by gradeCollected and runEval: accuracy = passing/total.
function summarize(results, passThreshold) {
  const passing = results.filter(r => r.passing).length;
  return {
    results,
    total: results.length,
    accuracy: passing / results.length,
    averageScore: results.reduce((s, r) => s + r.score, 0) / results.length,
    passThreshold,
  };
}

// Grade a suite whose model outputs (and optional grader responses) were already
// collected by the calling skill — keeps the `muster prompt eval` CLI fully deterministic
// and offline, mirroring `muster score`. Each entry: { output, format?, graderResponse? }.
export function gradeCollected({ dataset, passThreshold = 7 }) {
  if (!Array.isArray(dataset) || dataset.length === 0)
    throw new Error("gradeCollected: dataset must be a non-empty array");
  const results = dataset.map((entry) => {
    const { output, format, graderResponse } = entry;
    const code = codeGrade(output, format);
    const model = graderResponse != null ? parseGraderResponse(String(graderResponse)).score : null;
    const score = combineScores(code, model);
    // Pull only the known fields (not a blind ...entry spread) so a hostile suite file
    // cannot leak keys like __proto__ into the result objects.
    return { output, format, graderResponse, codeScore: code, modelScore: model, score, passing: score >= passThreshold };
  });
  return summarize(results, passThreshold);
}

// Library API (not used by the CLI, which grades pre-collected outputs via gradeCollected):
// run a full suite end-to-end. `callModel` is invoked once for the prompt-under-test and
// again for the grader prompt (built by buildGraderPrompt); a caller wiring a real model
// can branch on the prompt or inject a dedicated grader. A promptfoo adapter can satisfy
// the same contract.
export async function runEval({ dataset, promptTemplate, callModel, rubric, passThreshold = 7 }) {
  if (!Array.isArray(dataset) || dataset.length === 0)
    throw new Error("runEval: dataset must be a non-empty array");
  const results = [];
  for (const testCase of dataset) {
    const prompt = interpolate(promptTemplate, testCase);
    const output = await callModel(prompt);
    const graded = await gradeOne({ testCase, output, callModel, rubric });
    results.push({ testCase, output, ...graded, passing: graded.score >= passThreshold });
  }
  return summarize(results, passThreshold);
}
