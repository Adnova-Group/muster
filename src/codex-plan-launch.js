import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_JSON_RPC_FRAME_BYTES = 1024 * 1024;
const MAX_QUEUED_NOTIFICATIONS = 64;
const QUEUED_NOTIFICATION_METHODS = new Set(["thread/settings/updated", "turn/completed"]);
const PLAN_SKILL = "muster-plan";
const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;

export function sanitizeTerminalText(value) {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function readSecretTerminalInput({ input, output, timeoutMs, signal } = {}) {
  if (!input?.isTTY || typeof input.setRawMode !== "function" || typeof output?.write !== "function")
    return Promise.reject(new Error("secret App Server input requires an interactive terminal"));
  return new Promise((resolveInput, rejectInput) => {
    let answer = "";
    let settled = false;
    const wasRaw = Boolean(input.isRaw);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      try { input.setRawMode(wasRaw); } catch {}
      output.write("\n");
      if (error) rejectInput(error);
      else resolveInput(value);
    };
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") return finish(null, answer);
        if (character === "\u0003") return finish(new Error("secret input cancelled"));
        if (character === "\u0004") return finish(new Error("secret input ended before an answer was submitted"));
        if (character === "\u007f" || character === "\b") answer = answer.slice(0, -1);
        else if (character >= " ") answer += character;
      }
    };
    const onEnd = () => finish(new Error("secret input ended before an answer was submitted"));
    const onError = error => finish(error instanceof Error ? error : new Error(String(error)));
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("secret input cancelled"));
    const timeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
    const timer = timeout === null ? null : setTimeout(() => finish(new Error("App Server input auto-resolved before an answer was submitted")), timeout);
    try {
      if (signal?.aborted) return finish(signal.reason instanceof Error ? signal.reason : new Error("secret input cancelled"));
      input.setRawMode(true);
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("close", onEnd);
      input.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      input.resume?.();
      output.write("> ");
    } catch (error) {
      finish(error);
    }
  });
}

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
  write(`\n[Codex Plan output]\n${sanitizeTerminalText(item.text).trim()}\n`);
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
  const autoResolutionMs = Number.isInteger(params?.autoResolutionMs) && params.autoResolutionMs >= 0
    ? params.autoResolutionMs
    : null;
  const deadline = autoResolutionMs === null ? null : Date.now() + autoResolutionMs;
  const answers = {};
  for (const question of questions) {
    if (!question?.id || !question?.question) throw new Error("native Plan mode returned a malformed user-input question");
    const options = Array.isArray(question.options) ? question.options : [];
    const remainingMs = deadline === null ? null : deadline - Date.now();
    if (remainingMs !== null && remainingMs <= 0)
      throw new Error("App Server input auto-resolved before an answer was submitted");
    const raw = String(await ask(question, options, remainingMs)).trim();
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
  const requested = typeof cwd === "string" ? resolve(cwd) : null;
  const matches = requested === null ? [] : entries.filter(candidate => {
    if (typeof candidate?.cwd !== "string") return false;
    try { return resolve(candidate.cwd) === requested; }
    catch { return false; }
  });
  if (matches.length !== 1) return null;
  const [entry] = matches;
  if (Array.isArray(entry.errors) && entry.errors.length > 0) return null;
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
  let threadId;
  let turnId;
  try {
    control ??= await clientFactory({ cwd });
    await control.request("initialize", {
      clientInfo: { name: "muster", title: "Muster native Plan launcher", version: PACKAGE_VERSION },
      capabilities: { experimentalApi: true },
    });
    await control.notify("initialized");
    const [presets, skills, thread] = await Promise.all([
      control.request("collaborationMode/list", {}),
      control.request("skills/list", { cwds: [cwd], forceReload: true }),
      control.request("thread/start", { cwd }),
    ]);
    threadId = thread?.thread?.id;
    if (typeof threadId !== "string" || !threadId.trim())
      throw new Error("thread/start did not return a valid thread id");
    const collaborationMode = buildPlanCollaborationMode(presets.data, thread);
    const skill = findPlanSkill(skills, cwd);
    const params = buildPlanTurnStart({
      threadId,
      outcome,
      skill,
      collaborationMode,
    });
    const started = await control.request("turn/start", params);
    turnId = started?.turn?.id;
    if (typeof turnId !== "string" || !turnId.trim())
      throw new Error("turn/start did not return a valid turn id");
    const settings = await control.waitForNotification(
      "thread/settings/updated",
      message => message.params?.threadId === threadId
        && detectEffectivePlanMode(message).active,
    );
    const effective = detectEffectivePlanMode(settings);
    if (!effective.active)
      throw new Error(`turn/start effective collaboration mode was ${effective.effectiveMode}, not plan`);
    return {
      status: "started",
      native: true,
      effectiveMode: effective.effectiveMode,
      threadId,
      turnId,
    };
  } catch (error) {
    if (!client) await control?.close?.({ threadId, turnId, interrupt: Boolean(threadId && turnId) }).catch(() => {});
    return {
      ...fallbackPlanLaunch(outcome, error),
      ...(threadId && turnId ? { threadId, turnId } : {}),
    };
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
    this.closing = false;
    this.userInput = userInput;
    this.onNotification = onNotification;
    this.inputControllers = new Set();
    this.activeThreadId = null;
    this.activeTurnId = null;
    this.exitPromise = new Promise(resolveExit => child.once("exit", resolveExit));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.#consume(chunk));
    child.stdin.on("error", error => this.#terminate(error));
    child.stdout.on("error", error => this.#terminate(error));
    child.on("error", error => this.#terminate(error));
    child.on("exit", code => this.#terminate(new Error(`codex app-server exited with code ${code}`), false));
  }

  request(method, params = {}) {
    if (this.closed || (this.closing && method !== "turn/interrupt"))
      return Promise.reject(new Error("codex app-server control is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, params });
      if (!this.#write({ jsonrpc: "2.0", id, method, params }))
        this.#terminate(new Error("codex app-server control write failed"));
    });
  }

  async notify(method, params) {
    if (!this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }))
      throw new Error("codex app-server control is closed");
  }

  waitForNotification(method, predicate = () => true, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error("codex app-server control is closed"));
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

  async interruptTurn(threadId, turnId) {
    if (this.closed || typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) return;
    const interrupted = this.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    await Promise.race([interrupted, new Promise(resolveWait => setTimeout(resolveWait, 250))]);
  }

  async close({ threadId, turnId, interrupt = false } = {}) {
    this.closing = true;
    this.#abortInputs();
    if (interrupt) await this.interruptTurn(threadId, turnId);
    this.#abortInputs();
    if (!this.closed) {
      this.closed = true;
      this.#failAll(new Error("codex app-server control closed"));
      try { this.child.stdin.end(); } catch {}
      try { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(); } catch {}
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise(resolveWait => setTimeout(() => resolveWait(false), 250)),
    ]);
    if (!exited) {
      try { this.child.kill("SIGKILL"); } catch {}
      await Promise.race([this.exitPromise, new Promise(resolveWait => setTimeout(resolveWait, 250))]);
    }
  }

  #write(message) {
    if (this.closed || this.child.stdin.destroyed) return false;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); return true; }
    catch { return false; }
  }

  #consume(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_JSON_RPC_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.#terminate(new Error("codex app-server JSON-RPC frame buffer is too large"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_JSON_RPC_FRAME_BYTES) {
        this.#terminate(new Error("codex app-server JSON-RPC frame is too large"));
        return;
      }
      let message;
      try { message = JSON.parse(line); }
      catch { this.#terminate(new Error("codex app-server emitted invalid JSON-RPC output")); return; }
      if (!this.#validMessage(message)) {
        this.#terminate(new Error("codex app-server emitted invalid JSON-RPC output"));
        return;
      }
      if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method} failed: ${message.error.message ?? "unknown error"}`));
        else {
          if (pending.method === "turn/start"
            && typeof pending.params?.threadId === "string" && pending.params.threadId
            && typeof message.result?.turn?.id === "string" && message.result.turn.id) {
            this.activeThreadId = pending.params.threadId;
            this.activeTurnId = message.result.turn.id;
          }
          pending.resolve(message.result);
        }
        continue;
      }
      if (Object.hasOwn(message, "id")) {
        // This narrow launcher is an authoring surface, never an approval agent.
        // Any request that could authorize an action is declined, visibly, rather
        // than being auto-approved or silently inherited as an unsafe default.
        if (message.method === "item/tool/requestUserInput") {
          if (this.closing
            || message.params?.threadId !== this.activeThreadId
            || message.params?.turnId !== this.activeTurnId) {
            this.#write({ jsonrpc: "2.0", id: message.id, error: {
              code: -32000,
              message: "Muster's Plan launcher cannot answer input outside its active turn; resume with /plan for interactive input",
            } });
            continue;
          }
          const inputController = new AbortController();
          this.inputControllers.add(inputController);
          const ask = typeof this.userInput === "function"
            ? (question, options, timeoutMs) => this.userInput(question, options, timeoutMs, inputController.signal)
            : undefined;
          answerPlanUserInput(message.params, ask)
            .then(result => this.#write({ jsonrpc: "2.0", id: message.id, result }))
            .catch(error => this.#write({ jsonrpc: "2.0", id: message.id, error: {
              code: -32000,
              message: error.message,
            } }))
            .finally(() => this.inputControllers.delete(inputController));
        } else if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
          this.#write({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } });
          process.stderr.write(`muster: declined App Server request ${sanitizeTerminalText(message.method)}; approval was not bypassed\n`);
        } else if (["execCommandApproval", "applyPatchApproval"].includes(message.method)) {
          this.#write({ jsonrpc: "2.0", id: message.id, result: { decision: "denied" } });
          process.stderr.write(`muster: denied legacy App Server request ${sanitizeTerminalText(message.method)}; approval was not bypassed\n`);
        } else {
          this.#write({ jsonrpc: "2.0", id: message.id, error: {
            code: -32601,
            message: `Muster's non-interactive Plan launcher cannot answer ${sanitizeTerminalText(message.method)}; resume with /plan for interactive input`,
          } });
          process.stderr.write(`muster: App Server requested interactive input (${sanitizeTerminalText(message.method)}); no gate was answered automatically\n`);
        }
        continue;
      }
      try { this.onNotification?.(message); }
      catch (error) { this.#terminate(error); return; }
      let waiterIndex;
      try { waiterIndex = this.waiters.findIndex(waiter => waiter.method === message.method && waiter.predicate(message)); }
      catch (error) { this.#terminate(error); return; }
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else if (QUEUED_NOTIFICATION_METHODS.has(message.method)) {
        if (this.notifications.length >= MAX_QUEUED_NOTIFICATIONS) {
          this.#terminate(new Error("codex app-server notification backlog is too large"));
          return;
        }
        this.notifications.push(message);
      }
    }
  }

  #validMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0") return false;
    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    if (hasId && !["string", "number"].includes(typeof message.id)) return false;
    if (hasMethod && (typeof message.method !== "string" || !message.method)) return false;
    if (hasId && !hasMethod) {
      const hasResult = Object.hasOwn(message, "result");
      const hasError = Object.hasOwn(message, "error");
      if (hasResult === hasError) return false;
      return !hasError || (message.error && typeof message.error === "object"
        && typeof message.error.code === "number" && typeof message.error.message === "string");
    }
    return hasMethod;
  }

  #terminate(error, kill = true) {
    if (this.closed) return;
    this.closing = true;
    this.closed = true;
    this.buffer = "";
    this.#abortInputs(error);
    this.#failAll(error instanceof Error ? error : new Error(String(error)));
    if (kill) {
      try { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(); } catch {}
    }
  }

  #abortInputs(reason = new Error("codex app-server control closed")) {
    for (const controller of this.inputControllers) controller.abort(reason);
    this.inputControllers.clear();
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
