// Group tasks into dependency-ordered waves (Kahn-style level assignment).
// Input: tasks [{ id, deps?: string[] , ... }]. Output: Array<Array<task>> preserving input order within a wave.
export function computeWaves(tasks) {
  const byId = new Map();
  for (const t of tasks) byId.set(t.id, t);
  for (const t of tasks) for (const d of (t.deps || [])) {
    if (!byId.has(d)) throw new Error(`unknown dep "${d}" referenced by "${t.id}"`);
  }

  const done = new Set();
  const waves = [];
  let remaining = tasks.slice();

  while (remaining.length) {
    const ready = remaining.filter(t => (t.deps || []).every(d => done.has(d)));
    if (ready.length === 0) throw new Error("cycle detected in task deps");
    waves.push(ready);
    for (const t of ready) done.add(t.id);
    remaining = remaining.filter(t => !done.has(t.id));
  }
  return waves;
}
