const NON_RUNNING_STATES = new Set(["idle", "completed", "failed"]);

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
}

function requireDeadline(value) {
  if (!Number.isFinite(value)) throw new TypeError("deadlineAt must be a finite number");
}

function requireProcessGroupId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("processGroupId must be a positive safe integer");
  }
}

/**
 * Deterministic policy for the prose-driven Codex agent watch.
 *
 * Mailbox receipts intentionally do not reset a timer or heartbeat counter.
 * Active work is bounded only by the immutable absolute deadline established
 * at dispatch/tool-start; reconciled non-running workers retain the legacy
 * heartbeat-three exhaustion behavior.
 */
export function createAgentWatch({ deadlineAt, clock = Date.now, idleHeartbeatLimit = 3 }) {
  requireDeadline(deadlineAt);
  requireFunction(clock, "clock");
  if (!Number.isSafeInteger(idleHeartbeatLimit) || idleHeartbeatLimit <= 0) {
    throw new TypeError("idleHeartbeatLimit must be a positive safe integer");
  }

  let heartbeat = 0;
  let processGroupId;
  let toolStarted = false;
  let toolStopped = false;

  return Object.freeze({
    receipt(event) {
      if (!event || typeof event !== "object") throw new TypeError("receipt must be an object");
      if (event.type === "tool-start") {
        if (toolStarted && !toolStopped) throw new Error("tool-start already recorded");
        requireProcessGroupId(event.process_group_id);
        requireDeadline(event.deadline_at);
        if (event.deadline_at !== deadlineAt) {
          throw new Error("tool-start deadline_at must match the immutable watch deadline");
        }
        processGroupId = event.process_group_id;
        toolStarted = true;
        toolStopped = false;
      } else if (event.type === "tool-alive" || event.type === "tool-stop") {
        if (!toolStarted) throw new Error(`${event.type} requires tool-start`);
        if (event.process_group_id !== undefined && event.process_group_id !== processGroupId) {
          throw new Error(`${event.type} process_group_id does not match tool-start`);
        }
        if (event.type === "tool-stop") toolStopped = true;
      }
      // Ordinary mailbox chatter and tool-alive receipts are observations only.
      // Neither mutates deadlineAt nor grants more time.
    },

    tick({ threadState }) {
      heartbeat += 1;
      if (clock() >= deadlineAt) {
        return {
          action: "interrupt",
          reason: "deadline-exhausted",
          heartbeat,
          ...(toolStarted && !toolStopped ? { processGroupId } : {})
        };
      }
      if (NON_RUNNING_STATES.has(threadState) && heartbeat >= idleHeartbeatLimit) {
        return {
          action: "interrupt",
          reason: "heartbeat-exhausted",
          heartbeat,
          ...(toolStarted && !toolStopped ? { processGroupId } : {})
        };
      }
      return {
        action: "continue",
        reason: threadState === "running" ? "running-before-deadline" : "awaiting-liveness-checkpoint",
        heartbeat
      };
    }
  });
}

/**
 * Cancellation is complete only after the owned process group exits and a
 * structured tool-stop cleanup receipt is durably recorded.
 */
export async function cancelOwnedProcessGroup({
  processGroupId,
  reason,
  interruptWorker,
  terminateProcessGroup,
  waitForExit,
  recordCleanupReceipt
}) {
  requireProcessGroupId(processGroupId);
  for (const [name, callback] of Object.entries({
    interruptWorker,
    terminateProcessGroup,
    waitForExit,
    recordCleanupReceipt
  })) requireFunction(callback, name);

  await interruptWorker(reason);
  await terminateProcessGroup(processGroupId);
  await waitForExit(processGroupId);
  const expectedReceipt = {
    type: "tool-stop",
    process_group_id: processGroupId,
    reason,
    cleanup: "complete"
  };
  const receipt = await recordCleanupReceipt(expectedReceipt);
  if (
    !receipt
    || receipt.type !== expectedReceipt.type
    || receipt.process_group_id !== processGroupId
    || receipt.cleanup !== "complete"
  ) {
    throw new Error("cleanup receipt required after owned process group exit");
  }
  return receipt;
}
