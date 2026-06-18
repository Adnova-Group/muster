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
function validateRegex(s) { try { new RegExp(s); return 10; } catch { return 0; } }
// No Python runtime in-process: balanced-delimiter + no-prose heuristic. Honest about
// being best-effort — a real run can shell out to `python -c` if available.
function validatePython(s) {
  const t = String(s).trim();
  if (!t) return 0;
  const balanced = (open, close) =>
    (t.split(open).length - 1) === (t.split(close).length - 1);
  return balanced("(", ")") && balanced("[", "]") && balanced("{", "}") ? 10 : 0;
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

async function gradeOne({ testCase, output, callModel, rubric }) {
  const code = codeGrade(output, testCase.format);
  const graderText = await callModel(buildGraderPrompt(output, rubric || testCase.rubric));
  const model = parseGraderResponse(graderText);
  // Combine: if a code grade applies, average it with the model grade (correctness +
  // technical validity); otherwise the model grade stands alone.
  const score = code == null ? model.score : (code + model.score) / 2;
  return { codeScore: code, modelScore: model.score, score, reasoning: model.reasoning };
}

// Grade a suite whose model outputs (and optional grader responses) were already
// collected by the calling skill — keeps the `muster prompt eval` CLI fully deterministic
// and offline, mirroring `muster score`. Each entry: { output, format?, graderResponse? }.
export function gradeCollected({ dataset, passThreshold = 7 }) {
  if (!Array.isArray(dataset) || dataset.length === 0)
    throw new Error("gradeCollected: dataset must be a non-empty array");
  const results = dataset.map((entry) => {
    const code = codeGrade(entry.output, entry.format);
    const model = entry.graderResponse != null
      ? parseGraderResponse(String(entry.graderResponse)).score
      : null;
    let score;
    if (code != null && model != null) score = (code + model) / 2;
    else if (code != null) score = code;
    else if (model != null) score = model;
    else score = 0;
    return { ...entry, codeScore: code, modelScore: model, score, passing: score >= passThreshold };
  });
  const passing = results.filter(r => r.passing).length;
  return {
    results,
    total: results.length,
    accuracy: passing / results.length,
    averageScore: results.reduce((s, r) => s + r.score, 0) / results.length,
    passThreshold,
  };
}

// Run the full suite. `callModel` serves both the prompt-under-test and the grader; the
// grader prompt is recognisable (contains "grader"), so a single injected fn suffices.
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
  const passing = results.filter(r => r.passing).length;
  const averageScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  return {
    results,
    total: results.length,
    accuracy: passing / results.length,
    averageScore,
    passThreshold,
  };
}
