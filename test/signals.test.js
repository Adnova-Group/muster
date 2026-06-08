import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSignals } from "../src/signals.js";

describe("buildSignals", () => {
  it("merges profile and capability roles into a signals object", () => {
    const profile = { shape: "backend" };
    const capabilities = {
      roles: {
        implement: {
          chosen: { id: "x", source: "builtin" },
          model: "sonnet",
          chain: [],
          recommendations: []
        }
      }
    };
    const result = buildSignals(profile, capabilities);
    assert.deepEqual(result, {
      profile: { shape: "backend" },
      roles: {
        implement: {
          chosen: { id: "x", source: "builtin" },
          model: "sonnet"
        }
      }
    });
  });

  it("handles empty roles", () => {
    const result = buildSignals({ shape: "frontend" }, { roles: {} });
    assert.deepEqual(result, { profile: { shape: "frontend" }, roles: {} });
  });
});
