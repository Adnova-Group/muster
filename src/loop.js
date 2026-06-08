// Ralph-loop controller (the Ralph Wiggum technique): keep iterating an outcome until its success
// criteria are GENUINELY met (`done`), or the max-iterations cap is hit (then stop + escalate — never
// loop forever, never declare done falsely). The "self-reference" is that each iteration sees prior
// work in files + the run STATE.
export function loopState({ iteration, maxIterations = 25, done = false }) {
  if (done) return { continue: false, reason: "done" };
  if (iteration >= maxIterations) return { continue: false, reason: "max-iterations" };
  return { continue: true, reason: "iterate" };
}
