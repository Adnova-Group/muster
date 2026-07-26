#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

const worker = new URL("../test/fixtures/codex-fix-loop/benchmark-worker.mjs", import.meta.url);
const names = ["auth", "billing", "catalog", "cli", "config", "doctor", "hooks", "install", "router", "wave"];
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (outputIndex >= 0 && !outputPath) throw new Error("--output requires a path");

const retained = spawn(process.execPath, [worker.pathname], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: retained.stdout, crlfDelay: Infinity });
const pending = [];
lines.on("line", line => pending.shift()?.(JSON.parse(line)));

function retainedTurn(prompt) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    pending.push(event => resolve({ event, wallTimeMs: performance.now() - started }));
    retained.stdin.write(JSON.stringify({ prompt }) + "\n", error => {
      if (error) reject(error);
    });
  });
}

await retainedTurn("warmup");
const cases = [];
for (const [index, name] of names.entries()) {
  const source = `case=${name}\n` + `${name}: resolved implementation context and prior tool evidence\n`.repeat(850 + index * 20);
  const blocker = `${name}.js:${index + 10} blocker delta ${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;

  const freshStarted = performance.now();
  const fresh = spawnSync(process.execPath, [worker.pathname, "--oneshot"], {
    input: JSON.stringify({ prompt: `${source}\n${blocker}` }),
    encoding: "utf8",
    maxBuffer: 1_048_576
  });
  const freshWallTimeMs = performance.now() - freshStarted;
  if (fresh.status !== 0) throw new Error(`fresh benchmark worker failed for ${name}: ${fresh.stderr}`);

  const continued = await retainedTurn(blocker);
  cases.push({
    case: name,
    payloadSha256: createHash("sha256").update(source).digest("hex"),
    fresh: { ...JSON.parse(fresh.stdout), wallTimeMs: freshWallTimeMs },
    continued: { ...continued.event, wallTimeMs: continued.wallTimeMs }
  });
}
retained.stdin.end();
await new Promise((resolve, reject) => {
  retained.once("exit", code => code === 0 ? resolve() : reject(new Error(`retained worker exited ${code}`)));
});

const evidence = {
  harness: "local-process fresh-dispatch vs retained-thread protocol benchmark",
  command: "node scripts/benchmark-codex-fix-loop.mjs --output test/fixtures/codex-fix-loop/benchmark-evidence.json",
  nodeVersion: process.version,
  generatedAt: new Date().toISOString(),
  cases
};
const serialized = JSON.stringify(evidence, null, 2) + "\n";
if (outputPath) await writeFile(outputPath, serialized);
else process.stdout.write(serialized);
