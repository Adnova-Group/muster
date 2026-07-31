import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;
const PLAN_SKILL = "muster-plan";

export function buildPlanCollaborationMode(presets, thread) {
  const preset = Array.isArray(presets)
    ? presets.find(candidate => candidate?.mode === "plan")
    : null;
  if (!preset) throw new Error("collaborationMode/list did not advertise the Plan preset");
  const model = preset.model ?? thread?.model;
  if (typeof model !== "string" || model.length === 0)
    throw new Error("the Plan preset and thread/start response did not provide an effective model");
  return {
    mode: preset.mode,
    settings: {
      model,
      reasoning_effort: preset.reasoning_effort ?? thread?.reasoningEffort ?? null,
      developer_instructions: null,
    },
  };
}

export function detectEffectivePlanMode(notification) {
  const mode = notification?.method === "thread/settings/updated"
    ? notification.params?.threadSettings?.collaborationMode?.mode
    : null;
  return mode === "plan"
    ? { effectiveMode: "plan", active: true }
    : { effectiveMode: typeof mode === "string" ? mode : "unknown", active: false };
}

export function renderPlanNotification(notification, write) {
  if (notification?.method !== "item/completed" || typeof write !== "function") return false;
  const item = notification.params?.item;
  if (!["plan", "agentMessage"].includes(item?.type) || typeof item.text !== "string" || !item.text.trim()) return false;
  write(`\n${item.text.trim()}\n`);
  return true;
}

export function classifyPlanTurn(turn) {
  const status = turn?.status;
  if (status === "completed") return { status, exitCode: 0 };
  return { status: ["failed", "interrupted"].includes(status) ? status : "failed", exitCode: 2 };
}

export async function answerPlanUserInput(params, ask) {
  if (typeof ask !== "function")
    throw new Error("native Plan mode requested user input, but this launcher has no interactive input surface");
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  if (questions.length === 0) throw new Error("native Plan mode requested an empty user-input form");
  const answers = {};
  for (const question of questions) {
    if (!question?.id || !question?.question) throw new Error("native Plan mode returned a malformed user-input question");
    const options = Array.isArray(question.options) ? question.options : [];
    const raw = String(await ask(question, options)).trim();
    if (!raw) throw new Error(`no answer supplied for ${question.id}`);
    const numeric = Number.parseInt(raw, 10);
    const selected = Number.isInteger(numeric) && String(numeric) === raw && numeric >= 1 && numeric <= options.length
      ? options[numeric - 1].label
      : options.find(option => option.label === raw)?.label ?? raw;
    answers[question.id] = { answers: [selected] };
  }
  return { answers };
}

export function buildPlanTurnStart({ threadId, outcome, skill, collaborationMode }) {
  if (!threadId) throw new Error("turn/start requires a thread id");
  if (!skill || skill.name !== PLAN_SKILL || typeof skill.path !== "string")
    throw new Error(`${PLAN_SKILL} is not available in skills/list for this working directory`);
  const text = `$${PLAN_SKILL}${outcome?.trim() ? ` ${outcome.trim()}` : ""}`;
  // Approval policy, approval reviewer, permissions, and sandbox are deliberately
  // absent. App Server therefore inherits the user's existing controls instead of
  // this authoring-surface launcher weakening or replacing them.
  return {
    threadId,
    input: [
      { type: "text", text },
      { type: "skill", name: skill.name, path: skill.path },
    ],
    collaborationMode,
  };
}

function findPlanSkill(response, cwd) {
  const entries = Array.isArray(response?.data) ? response.data : [];
  const entry = entries.find(candidate => candidate?.cwd === cwd) ?? entries[0];
  return entry?.skills?.find(skill => skill?.name === PLAN_SKILL && skill.enabled !== false) ?? null;
}

export function fallbackPlanLaunch(outcome, error) {
  const suffix = outcome?.trim() ? ` ${outcome.trim()}` : "";
  return {
    status: "fallback",
    native: false,
    effectiveMode: "unknown",
    reason: error instanceof Error ? error.message : String(error),
    guidance: `App Server could not confirm native Plan mode. In a controllable Codex session run: /plan $${PLAN_SKILL}${suffix}`,
  };
}

export async function launchCodexPlan({ client, clientFactory = createCodexAppServerClient, cwd, outcome = "" } = {}) {
  let control = client;
  try {
    control ??= await clientFactory({ cwd });
    await control.request("initialize", {
      clientInfo: { name: "muster", title: "Muster native Plan launcher", version: "0.5.0" },
      capabilities: { experimentalApi: true },
    });
    await control.notify("initialized");
    const [presets, skills, thread] = await Promise.all([
      control.request("collaborationMode/list", {}),
      control.request("skills/list", { cwds: [cwd], forceReload: true }),
      control.request("thread/start", { cwd }),
    ]);
    const collaborationMode = buildPlanCollaborationMode(presets.data, thread);
    const skill = findPlanSkill(skills, cwd);
    const params = buildPlanTurnStart({
      threadId: thread.thread?.id,
      outcome,
      skill,
      collaborationMode,
    });
    const started = await control.request("turn/start", params);
    const settings = await control.waitForNotification(
      "thread/settings/updated",
      message => (message.params?.threadId === undefined || message.params.threadId === thread.thread.id)
        && detectEffectivePlanMode(message).active,
    );
    const effective = detectEffectivePlanMode(settings);
    if (!effective.active)
      throw new Error(`turn/start effective collaboration mode was ${effective.effectiveMode}, not plan`);
    return {
      status: "started",
      native: true,
      effectiveMode: effective.effectiveMode,
      threadId: thread.thread.id,
      turnId: started.turn?.id,
    };
  } catch (error) {
    if (!client) await control?.close?.().catch(() => {});
    return fallbackPlanLaunch(outcome, error);
  }
}

export function createCodexAppServerClient({ cwd, timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = spawn, userInput, onNotification } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess("codex", ["app-server", "--stdio"], {
        cwd,
        stdio: ["pipe", "pipe", "inherit"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (!child?.stdin || !child?.stdout) {
      reject(new Error("codex app-server did not expose stdio control"));
      return;
    }
    resolve(new JsonRpcLineClient(child, timeoutMs, userInput, onNotification));
  });
}

class JsonRpcLineClient {
  constructor(child, timeoutMs, userInput, onNotification) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.buffer = "";
    this.closed = false;
    this.userInput = userInput;
    this.onNotification = onNotification;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.#consume(chunk));
    child.stdout.on("error", error => this.#failAll(error));
    child.on("error", error => this.#failAll(error));
    child.on("exit", code => this.#failAll(new Error(`codex app-server exited with code ${code}`)));
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("codex app-server control is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  waitForNotification(method, predicate = () => true, timeoutMs = this.timeoutMs) {
    const index = this.notifications.findIndex(message => message.method === method && predicate(message));
    if (index >= 0) return Promise.resolve(this.notifications.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex(waiter => waiter.resolve === resolve);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`${method} confirmation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ method, predicate, resolve, reject, timer });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch {}
    try { if (!this.child.killed) this.child.kill(); } catch {}
    this.#failAll(new Error("codex app-server control closed"));
  }

  #write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consume(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.#failAll(new Error("codex app-server emitted invalid JSON-RPC output")); continue; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method} failed: ${message.error.message ?? "unknown error"}`));
        else pending.resolve(message.result);
        continue;
      }
      if (message.id !== undefined && message.method) {
        // This narrow launcher is an authoring surface, never an approval agent.
        // Any request that could authorize an action is declined, visibly, rather
        // than being auto-approved or silently inherited as an unsafe default.
        if (message.method === "item/tool/requestUserInput") {
          answerPlanUserInput(message.params, this.userInput)
            .then(result => this.#write({ jsonrpc: "2.0", id: message.id, result }))
            .catch(error => this.#write({ jsonrpc: "2.0", id: message.id, error: {
              code: -32000,
              message: error.message,
            } }));
        } else if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
          this.#write({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } });
          process.stderr.write(`muster: declined App Server request ${message.method}; approval was not bypassed\n`);
        } else if (["execCommandApproval", "applyPatchApproval"].includes(message.method)) {
          this.#write({ jsonrpc: "2.0", id: message.id, result: { decision: "denied" } });
          process.stderr.write(`muster: denied legacy App Server request ${message.method}; approval was not bypassed\n`);
        } else {
          this.#write({ jsonrpc: "2.0", id: message.id, error: {
            code: -32601,
            message: `Muster's non-interactive Plan launcher cannot answer ${message.method}; resume with /plan for interactive input`,
          } });
          process.stderr.write(`muster: App Server requested interactive input (${message.method}); no gate was answered automatically\n`);
        }
        continue;
      }
      this.onNotification?.(message);
      const waiterIndex = this.waiters.findIndex(waiter => waiter.method === message.method && waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.notifications.push(message);
      }
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }
}
