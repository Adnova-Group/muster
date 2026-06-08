import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../src/doctor.js";

describe("runDoctor", () => {
  it("returns ok:true against the real repo root", async () => {
    const result = await runDoctor({ root: new URL("../", import.meta.url) });
    assert.equal(result.ok, true, `not ok: ${JSON.stringify(result.checks)}`);
    const names = result.checks.map(c => c.name);
    assert.ok(names.includes("catalog"), "missing catalog check");
    assert.ok(names.includes("pipelines"), "missing pipelines check");
    assert.ok(names.includes("builtins"), "missing builtins check");
    assert.ok(names.includes("node>=20"), "missing node>=20 check");
    const catalogCheck = result.checks.find(c => c.name === "catalog");
    assert.ok(catalogCheck.detail.includes("entries"), `catalog detail should mention entries: ${catalogCheck.detail}`);
  });
});
