import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeProfileForConfig } from "../src/claude.js";
import { codexProfileForConfig } from "../src/codex.js";
import { kimiProfileForConfig } from "../src/kimi.js";

const adapters = {
  claude: {
    resolve: claudeProfileForConfig,
    prime: { model: "opus" },
    core: { model: "sonnet" },
  },
  codex: {
    resolve: codexProfileForConfig,
    prime: { model: "gpt-5.6-sol", effort: "high" },
    core: { model: "gpt-5.6-luna", effort: "xhigh" },
  },
  kimi: {
    resolve: kimiProfileForConfig,
    prime: { model: "kimi-code/k3", effort: "high" },
    core: { model: "kimi-code/kimi-for-coding", thinking: "enabled" },
  },
};

test("legacy fable profile aliases obey apex opt-in governance on all adapters", () => {
  const saved = {
    apex: process.env.MUSTER_ENABLE_APEX,
    fable: process.env.MUSTER_ENABLE_FABLE,
    cap: process.env.MUSTER_MAX_TIER,
  };
  try {
    delete process.env.MUSTER_ENABLE_APEX;
    delete process.env.MUSTER_ENABLE_FABLE;
    delete process.env.MUSTER_MAX_TIER;

    for (const [name, adapter] of Object.entries(adapters)) {
      assert.deepEqual(
        adapter.resolve({ tier: "fable" }),
        adapter.prime,
        `${name}: a legacy apex alias must degrade to prime until apex is enabled`,
      );
    }
  } finally {
    for (const [key, value] of [
      ["MUSTER_ENABLE_APEX", saved.apex],
      ["MUSTER_ENABLE_FABLE", saved.fable],
      ["MUSTER_MAX_TIER", saved.cap],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("legacy tier aliases obey a legacy MUSTER_MAX_TIER cap on all adapters", () => {
  const saved = {
    apex: process.env.MUSTER_ENABLE_APEX,
    cap: process.env.MUSTER_MAX_TIER,
  };
  try {
    process.env.MUSTER_ENABLE_APEX = "1";
    process.env.MUSTER_MAX_TIER = "sonnet";

    for (const [name, adapter] of Object.entries(adapters)) {
      assert.deepEqual(
        adapter.resolve({ tier: "fable" }),
        adapter.core,
        `${name}: legacy fable must be capped by legacy MUSTER_MAX_TIER=sonnet`,
      );
    }
  } finally {
    for (const [key, value] of [
      ["MUSTER_ENABLE_APEX", saved.apex],
      ["MUSTER_MAX_TIER", saved.cap],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
