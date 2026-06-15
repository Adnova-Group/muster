// Group tasks into dependency-ordered waves (Kahn-style level assignment).
// Input: tasks [{ id, deps?: string[] , ... }]. Output: Array<Array<task>> preserving input order within a wave.
export function computeWaves(tasks) {
  if (!Array.isArray(tasks)) throw new Error("computeWaves: tasks must be an array");
  const byId = new Map();
  for (const t of tasks) {
    if (byId.has(t.id)) throw new Error(`duplicate task id "${t.id}"`);
    byId.set(t.id, t);
  }
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

// Single-agent / sequential driver: given a plan and the set of completed task ids,
// return what to run next. A runtime that can fan out takes the whole `ready` frontier;
// a single-agent runtime (e.g. Cowork with no parallel dispatch) takes `next` — the
// lowest-wave ready task — runs it, appends its id to completed, and asks again.
// Reuses computeWaves for validation (duplicate id / unknown dep / cycle all throw)
// and for wave indices, so cross-wave order stays fixed.
export function nextTasks(tasks, completed = []) {
  const waves = computeWaves(tasks);
  const waveOf = new Map();
  waves.forEach((w, i) => w.forEach(t => waveOf.set(t.id, i)));

  const ids = new Set(tasks.map(t => t.id));
  const doneSet = new Set(completed);
  const unknownCompleted = [...doneSet].filter(id => !ids.has(id));

  const remaining = tasks.filter(t => !doneSet.has(t.id));
  const ready = remaining
    .filter(t => (t.deps || []).every(d => doneSet.has(d)))
    .map(t => ({ ...t, wave: waveOf.get(t.id) }))
    .sort((x, y) => x.wave - y.wave);
  const blocked = remaining
    .filter(t => (t.deps || []).some(d => !doneSet.has(d)))
    .map(t => ({ id: t.id, missing: (t.deps || []).filter(d => !doneSet.has(d)) }));

  return {
    done: remaining.length === 0,
    next: ready[0] || null,
    ready,
    blocked,
    remaining: remaining.length,
    ...(unknownCompleted.length ? { unknownCompleted } : {}),
  };
}
