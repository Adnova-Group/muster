// Canon-ledger mechanics for book runs (src/book.js): outline validation, dependency waves, canon
// facts, continuity debts (opened, deduplicated, propagated by an amend, closed by a re-check) and
// the `muster book` CLI round trip on a real run directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  amendCanon, bookArgs, builtinsDir, bookStatus, chapterWaves, newBook, recordResult, renderCanon, renderLedger, runBookCli, validateOutline, wordCount,
} from "../src/book.js";
import { sha256 } from "../src/fs-safe.js";

const outline = (over = {}) => ({
  status: "done", title: "Salt Road", kind: "fiction", premise: "A smuggler crosses the salt flats one last time.",
  voice: { pov: "third limited, Mara", tense: "past", notes: "dry, close" },
  chapters: [
    { id: "ch01", title: "The Ledger", goal: "Mara takes the job", dependsOn: [] },
    { id: "ch02", title: "Inland", goal: "Her brother's side of it", dependsOn: [], pov: "first, Teo" },
    { id: "ch03", title: "The Flats", goal: "The crossing goes wrong", dependsOn: ["ch01"] },
    { id: "ch04", title: "Salt", goal: "Both threads meet", dependsOn: ["ch02", "ch03"] },
  ],
  canon: [{ fact: "Mara is 34", category: "character" }, { fact: "Mara's eyes are brown", category: "character" }, { fact: "mara is 34!", category: "character" }],
  summary: "", ...over,
});
const fresh = () => newBook("salt-road", outline()).book;
const draft = (id, over = {}) => ({ chapterId: id, status: "done", path: `.muster/runs/salt-road/chapters/${id}.md`, words: 1, summary: `${id} summary`, canonUsed: [], newCanon: [], notes: [], ...over });
const files = (ids) => Object.fromEntries(ids.map((id) => [id, `# ${id}\n\nMara walked on.\n`]));

test("outline validation catches bad ids, unknown or self dependencies, cycles and a missing kind", () => {
  assert.deepEqual(validateOutline(outline()), []);
  const bad = validateOutline({ title: "x", chapters: [
    { id: "Ch 1", goal: "g", dependsOn: [] },
    { id: "a", goal: "g", dependsOn: ["b"] },
    { id: "b", goal: "g", dependsOn: ["a"] },
    { id: "c", goal: "", dependsOn: ["c", "zz"] },
  ] });
  assert.ok(bad.some((p) => /kind must be/.test(p)));
  assert.ok(bad.some((p) => /chapters\[0\]\.id/.test(p)));
  assert.ok(bad.some((p) => /c has no goal/.test(p)));
  assert.ok(bad.some((p) => /c depends on itself/.test(p)));
  assert.ok(bad.some((p) => /unknown chapter zz/.test(p)));
  const cyc = validateOutline(outline({ chapters: [{ id: "a", goal: "g", dependsOn: ["b"] }, { id: "b", goal: "g", dependsOn: ["a"] }] }));
  assert.deepEqual(cyc, ["dependency cycle among a, b"]);
});

test("newBook seeds chapters and canon; duplicate facts collapse; per-chapter POV overrides the book voice", () => {
  const book = fresh();
  assert.deepEqual(book.chapters.map((c) => [c.id, c.status, c.path]), [
    ["ch01", "planned", ".muster/runs/salt-road/chapters/ch01.md"], ["ch02", "planned", ".muster/runs/salt-road/chapters/ch02.md"],
    ["ch03", "planned", ".muster/runs/salt-road/chapters/ch03.md"], ["ch04", "planned", ".muster/runs/salt-road/chapters/ch04.md"],
  ]);
  assert.deepEqual(book.canon.map((c) => [c.id, c.fact]), [["C-001", "Mara is 34"], ["C-002", "Mara's eyes are brown"]]);
  assert.equal(book.chapters[1].pov, "first, Teo");
  assert.equal(book.chapters[0].pov, "third limited, Mara");
  assert.equal(newBook("salt-road", { kind: "poem" }).book, null);
  assert.throws(() => newBook("../escape", outline()), /invalid runId/);
});

test("chapterWaves layers by dependency; outside deps count only when done", () => {
  const { waves, blocked } = chapterWaves(fresh().chapters);
  assert.deepEqual(waves.map((w) => w.map((c) => c.id)), [["ch01", "ch02"], ["ch03"], ["ch04"]]);
  assert.deepEqual(blocked, []);
  const sub = fresh().chapters.filter((c) => c.id !== "ch01");
  assert.deepEqual(chapterWaves(sub).blocked.map((b) => b.id), ["ch03", "ch04"], "ch03 waits on undrafted ch01, ch04 waits on ch03");
  assert.deepEqual(chapterWaves(sub, { done: (id) => id === "ch01" }).waves.map((w) => w.map((c) => c.id)), [["ch02", "ch03"], ["ch04"]]);
});

test("bookArgs takes whole waves up to the limit and only schedules whole-book passes on the final batch", () => {
  const book = fresh();
  const a = bookArgs(book, { limit: 3 });
  assert.deepEqual(a.args.waves.map((w) => w.map((c) => c.id)), [["ch01", "ch02"], ["ch03"]]);
  assert.equal(a.remaining, 1);
  assert.deepEqual(a.args.passes, { continuity: true, developmental: false, lineEdit: false, beta: 0 });
  assert.equal(a.args.canonPath, ".muster/runs/salt-road/CANON.md");
  assert.deepEqual(a.args.manuscript.map((c) => c.id), ["ch01", "ch02", "ch03", "ch04"]);
  const all = bookArgs(book, { limit: 10, beta: 2, models: { writer: { model: "opus" } } });
  assert.equal(all.remaining, 0);
  assert.deepEqual(all.args.passes, { continuity: true, developmental: true, lineEdit: true, beta: 2 });
  assert.deepEqual(all.args.models, { writer: { model: "opus" } });
  assert.deepEqual(bookArgs(book, { limit: 1 }).args.waves.map((w) => w.map((c) => c.id)), [["ch01"]], "a wave larger than the limit is cut");
});

test("recording a pass: drafts, canon from disk-verified chapters, continuity issues become debts", () => {
  const book = fresh();
  const result = {
    runId: "salt-road",
    drafts: [
      draft("ch01", { canonUsed: ["C-001", "C-999"], newCanon: [{ fact: "The Ledger is a bar in Ostra", category: "place", line: 4 }] }),
      draft("ch02", { newCanon: [{ fact: "Teo owes the Hask family money", category: "character" }] }),
      draft("ch03"), // reported done, but no file on disk
      { chapterId: "ch04", status: "error", error: "boom" },
    ],
    continuity: [
      { chapterId: "ch01", rounds: 1, final: { chapterId: "ch01", verdict: "PASS", issues: [], debtsResolved: [] }, fixes: [], debtsShown: [] },
      { chapterId: "ch02", rounds: 3, debtsShown: [], fixes: [draft("ch02", { newCanon: [{ fact: "Teo is 29", category: "character" }] })], final: { chapterId: "ch02", verdict: "ISSUES", debtsResolved: [], issues: [
        { chapter: "ch02", line: 12, quote: "Mara's green eyes", canonId: "C-002", canonFact: "Mara's eyes are brown", kind: "contradiction", severity: "major", summary: "eye colour", maybeIntentional: false },
        { chapter: "ch01", line: 3, quote: "the bar on the coast", canonId: "", canonFact: "ch02 puts Ostra inland", kind: "geography", severity: "minor", summary: "Ostra moved", maybeIntentional: true },
      ] } },
    ],
  };
  const r = recordResult(book, result, { files: files(["ch01", "ch02"]) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pass.drafted, ["ch01", "ch02"]);
  assert.deepEqual(r.pass.failed, ["ch03", "ch04"]);
  assert.match(r.problems[0], /ch03: the writer reported done but .* is missing/);
  assert.deepEqual(book.chapters.map((c) => c.status), ["checked", "drafted", "planned", "planned"]);
  assert.deepEqual(r.pass.canonAdded, ["C-003", "C-004", "C-005"]);
  assert.deepEqual(book.chapters[0].canonRefs, ["C-001", "C-003"], "unknown C-999 is dropped");
  assert.deepEqual(book.chapters[1].canonRefs, ["C-004", "C-005"]);
  assert.equal(book.chapters[0].words, wordCount(files(["ch01"]).ch01));
  assert.equal(book.chapters[0].hash, sha256(files(["ch01"]).ch01));
  assert.deepEqual(book.debts.map((d) => [d.id, d.chapter, d.line, d.canonId, d.severity, d.maybeIntentional]), [
    ["D-001", "ch02", 12, "C-002", "major", false],
    ["D-002", "ch01", 3, null, "minor", true],
  ]);
  assert.match(book.debts[1].summary, /\[geography\] Ostra moved \(established: ch02 puts Ostra inland\)/);
  // Reporting the same issue again does not open a duplicate debt.
  recordResult(book, { continuity: [result.continuity[1]] }, { files: files(["ch01", "ch02"]) });
  assert.equal(book.debts.length, 2);
  assert.equal(recordResult(book, { runId: "other" }).ok, false);
});

test("re-check closes the debts it was shown when it passes; ABSTAIN closes nothing", () => {
  const book = fresh();
  recordResult(book, { drafts: [draft("ch01")], continuity: [{ chapterId: "ch01", debtsShown: [], final: { verdict: "ISSUES", debtsResolved: [], issues: [
    { chapter: "ch01", line: 2, quote: "a", canonId: "C-001", canonFact: "Mara is 34", kind: "contradiction", severity: "major", summary: "age", maybeIntentional: false },
    { chapter: "ch01", line: 9, quote: "b", canonId: "C-002", canonFact: "brown", kind: "contradiction", severity: "major", summary: "eyes", maybeIntentional: false },
  ] } }] }, { files: files(["ch01"]) });
  assert.equal(bookStatus(book).openDebts, 2);
  recordResult(book, { continuity: [{ chapterId: "ch01", debtsShown: ["D-001", "D-002"], final: { verdict: "ABSTAIN", issues: [], debtsResolved: ["D-001"] } }] }, { files: files(["ch01"]) });
  assert.equal(bookStatus(book).openDebts, 2, "no evidence, no closure");
  recordResult(book, { continuity: [{ chapterId: "ch01", debtsShown: ["D-001"], final: { verdict: "ISSUES", issues: [], debtsResolved: ["D-001", "D-002"] } }] }, { files: files(["ch01"]) });
  assert.deepEqual(book.debts.map((d) => d.status), ["closed", "open"], "only a debt the checker was shown can be closed by it");
  recordResult(book, { continuity: [{ chapterId: "ch01", debtsShown: ["D-002"], final: { verdict: "PASS", issues: [], debtsResolved: [] } }] }, { files: files(["ch01"]) });
  assert.equal(bookStatus(book).openDebts, 0);
  assert.equal(book.chapters[0].status, "checked");
});

test("amending a canon fact propagates a debt to every written chapter that relied on it", () => {
  const book = fresh();
  recordResult(book, { drafts: [draft("ch01", { canonUsed: ["C-002"] }), draft("ch02", { canonUsed: ["C-001"] })] }, { files: files(["ch01", "ch02"]) });
  const r = amendCanon(book, "C-002", "Mara's eyes are grey");
  assert.equal(r.ok, true);
  assert.equal(r.canonId, "C-003");
  assert.deepEqual(r.opened, ["D-001"]);
  assert.equal(book.debts[0].chapter, "ch01");
  assert.equal(book.debts[0].origin, "amend");
  assert.deepEqual(book.chapters[0].canonRefs, ["C-003"], "the chapter now answers to the new fact");
  assert.equal(book.canon[1].status, "superseded");
  assert.equal(book.canon[1].supersededBy, "C-003");
  assert.equal(amendCanon(book, "C-002", "again").ok, false);
  assert.equal(amendCanon(book, "C-404", "x").ok, false);
  assert.match(renderCanon(book), /~~C-002 Mara's eyes are brown~~ -> C-003/);
  assert.match(renderLedger(book), /\*\*D-001\*\* ch01 \[major, amend\] vs C-003/);
});

test("a line edit that moves a canon fact opens a debt; an edited file is re-checked before new drafting", () => {
  const book = fresh();
  recordResult(book, { drafts: [draft("ch01"), draft("ch02")] }, { files: files(["ch01", "ch02"]) });
  recordResult(book, { lineEdits: [{ chapterId: "ch01", status: "done", path: "", edits: 2, patterns: [], canonTouched: [{ canonId: "C-001", line: 5, before: "Mara was 34", after: "Mara was 43" }] }] }, { files: files(["ch01", "ch02"]) });
  assert.equal(book.chapters[0].status, "edited");
  assert.equal(book.debts[0].origin, "line-edit");
  const hashes = { ch01: sha256("rewritten by the author"), ch02: book.chapters[1].hash, ch03: null, ch04: null };
  const { args, stale } = bookArgs(book, { hashes });
  assert.deepEqual(stale, ["ch01"]);
  assert.deepEqual(args.recheck.map((c) => [c.id, c.reason, c.debts.map((d) => d.id)]), [["ch01", "edited since last record", ["D-001"]]]);
  assert.deepEqual(bookStatus(book, { hashes }).next.action, "recheck");
});

test("status walks draft -> recheck -> polish -> review", () => {
  const book = fresh();
  assert.equal(bookStatus(book).next.action, "draft");
  recordResult(book, { drafts: ["ch01", "ch02", "ch03", "ch04"].map((id) => draft(id)) }, { files: files(["ch01", "ch02", "ch03", "ch04"]) });
  assert.equal(bookStatus(book).next.action, "polish");
  recordResult(book, { beta: [{ persona: "devourer", source: "simulated", finished: false, putDownChapter: "ch03", engagement: [], confusions: [], highlights: [], verdict: "" }] }, { files: {} });
  const s = bookStatus(book);
  assert.equal(s.next.action, "review");
  assert.match(s.next.why, /never marks a book ready/);
  assert.equal(s.chapters.drafted, 4);
  assert.deepEqual(book.passes.at(-1).beta, [{ persona: "devourer", finished: false, putDown: "ch03" }]);
});

test("muster book CLI: init, args, record, amend, close and status on a real run directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "book-run-"));
  try {
    const cli = (...a) => runBookCli(a, { cwd });
    await writeFile(join(cwd, "outline.json"), JSON.stringify({ runId: "salt-road", mode: "outline", outline: outline() }));
    let r = await cli("init", "salt-road", "--outline", "outline.json");
    assert.equal(r.code, 0, JSON.stringify(r.report));
    assert.deepEqual([r.report.chapters, r.report.canon], [4, 2]);
    assert.equal((await cli("init", "salt-road", "--outline", "outline.json")).code, 1, "init never overwrites a book");
    const dir = join(cwd, ".muster/runs/salt-road");
    assert.match(await readFile(join(dir, "CANON.md"), "utf8"), /\*\*C-001\*\* Mara is 34/);
    assert.match(await readFile(join(dir, "LEDGER.md"), "utf8"), /\| ch04 \| Salt \| planned \| 0 \| ch02, ch03 \| 0 \|/);

    r = await cli("args", "salt-road", "--limit", "2", "--model", "haiku");
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "book-args.json"), "utf8")).models.continuity, { model: "haiku" });
    assert.equal((await cli("args", "salt-road", "--model", "$(rm -rf)")).code, 2);
    assert.deepEqual(r.report.drafting, ["ch01", "ch02"]);
    const args = JSON.parse(await readFile(join(dir, "book-args.json"), "utf8"));
    assert.equal(args.builtinsDir, builtinsDir(), "the CLI hands the agents its own plugin's builtins directory");
    assert.match(await readFile(join(args.builtinsDir, "book-run", "SKILL.md"), "utf8"), /^---\nname: book-run\n/);
    assert.equal(args.mode, "pass");
    assert.equal(args.waves[0][0].path, ".muster/runs/salt-road/chapters/ch01.md");

    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters/ch01.md"), "# The Ledger\n\nMara counted the coins twice.\n");
    await writeFile(join(dir, "chapters/ch02.md"), "# Inland\n\nI never told her about the Hask money.\n");
    await writeFile(join(dir, "book-result-1.json"), JSON.stringify({
      runId: "salt-road", mode: "pass",
      drafts: [draft("ch01", { canonUsed: ["C-002"] }), draft("ch02", { newCanon: [{ fact: "Teo owes the Hask family money", category: "character", line: 3 }] })],
      continuity: [{ chapterId: "ch02", rounds: 1, fixes: [], debtsShown: [], final: { chapterId: "ch02", verdict: "ISSUES", debtsResolved: [], issues: [{ chapter: "ch02", line: 3, quote: "I never told her", canonId: "", canonFact: "ch01: Mara already knows", kind: "knowledge", severity: "major", summary: "Teo's secret is known", maybeIntentional: false }] } }],
    }));
    r = await cli("record", "salt-road", "--result", ".muster/runs/salt-road/book-result-1.json");
    assert.equal(r.code, 0, JSON.stringify(r.report));
    assert.deepEqual(r.report.drafted, ["ch01", "ch02"]);
    assert.deepEqual(r.report.debtsOpened, ["D-001"]);
    assert.equal(r.report.status.words, 7 + 9, "words are counted from the files, not from the agent report");
    assert.equal(r.report.status.next.action, "recheck");
    const state = await readFile(join(dir, "STATE.md"), "utf8");
    assert.match(state, /## Log\n- book init: 4 chapters, 2 canon facts\n- book pass 1: drafted ch01, ch02; canon \+1; debts \+1 -0/);

    r = await cli("amend", "salt-road", "C-002", "Mara's", "eyes", "are", "grey");
    assert.equal(r.code, 0);
    assert.deepEqual(r.report.opened, ["D-002"]);
    r = await cli("close", "salt-road", "D-001", "intentional:", "Teo", "lies");
    assert.equal(r.code, 0);
    assert.equal((await cli("close", "salt-road", "D-001", "again")).code, 1);

    // The author edits ch02 by hand: the next pass re-checks it with its open debts (none) and drafts the next wave.
    await writeFile(join(dir, "chapters/ch02.md"), "# Inland\n\nShe knew. Of course she knew.\n");
    r = await cli("args", "salt-road");
    assert.deepEqual(r.report.stale, ["ch02"]);
    assert.deepEqual(r.report.recheck.sort(), ["ch01", "ch02"]);
    assert.deepEqual(r.report.drafting, ["ch03", "ch04"]);
    assert.equal(r.report.passes.beta, 3);

    r = await cli("status", "salt-road");
    assert.equal(r.report.openDebts, 1);
    assert.equal((await cli("status", "nope")).report.next.action, "outline");
    await assert.rejects(readFile(join(cwd, ".muster/runs/nope/book.json")), "status never creates a run");
    assert.equal((await cli("args", "nope")).code, 1);
    await assert.rejects(readdir(join(cwd, ".muster/runs/nope")), "a typo'd runId leaves no directory behind");
    assert.equal((await cli("frob", "salt-road")).code, 2);
    assert.equal((await cli("args", "../x")).code, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
