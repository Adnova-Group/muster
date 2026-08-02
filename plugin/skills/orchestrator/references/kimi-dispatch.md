<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-POS-001: progressive-disclosure reference
loaded INTO the orchestrator skill's already-role-anchored context (no second persona),
and its prohibitions (sole-tool-call, distinct-prompts, foreground-at-the-barrier) are
binary-enforced rejection rules where the negative statement IS the contract. -->
<!-- Progressive-disclosure reference (skill-split item, 2026-07-29): the orchestrator's
Kimi-native dispatch mechanics, read on demand by Kimi-hosted sessions only -- a non-Kimi
session never loads this file. The `###` heading below is kept verbatim from its
pre-split home in SKILL.md so section-anchored guards and citations stay stable. The
step-4a "Subagent failure" bullet's Kimi native-resume clause and the Channel steering
section's Kimi steer-seam paragraph stay in SKILL.md itself -- they are build anchors for
scripts/build-codex.mjs's guarded rewrites and belong to harness-neutral rules. -->

### Kimi-native dispatch: AgentSwarm waves + per-agent calls

Kimi ships BOTH halves of wave dispatch natively -- `AgentSwarm` (fan-out + barrier +
aggregated report in ONE tool call) and the per-agent `Agent` call -- so on Kimi every wave
resolves through `resolveKimiWaveDispatch({ items, uniformTask })` (`src/kimi-dispatch.js`),
which picks the native shape straight from Kimi's own guidance: AgentSwarm is for "the same
kind of task over different inputs"; "For a few differently-shaped tasks, make separate
`Agent` calls in one message instead" (docs/research/kimi-code-cli.md sec 11.9). Step 4b's
barrier and step 4c's review gate are UNCHANGED in both modes -- only the fan-out mechanism
moves off the prose loop.

- **`mode: "agent-swarm"`** (uniform fan-out: one task over N inputs -- audit N files,
  review N modules) -- build ONE packet with `kimiSwarmCall({ promptTemplate, items,
  subagentType, model })` and dispatch it as the `AgentSwarm` tool; the swarm fans out,
  barriers, and returns the aggregated report itself. The `AgentSwarm` call MUST be the
  sole tool call in its response (the binary enforces it; `soleToolCall: true` on the
  packet is that contract). Swarm concurrency is the harness's own
  `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`, not a muster knob.
- **`mode: "agent-calls"`** (the default, and muster's usual case: a wave is N DISTINCT
  roles, not one template over N inputs) -- one `kimiAgentCall({ agentId, prompt,
  description, background })` per crew member, dispatched as separate `Agent` calls in one
  message. `agentId` is the crew member's resolved `chosen.id`; the call derives its model
  lane from the shared manifest, so a dispatch can never contradict the installed agent
  file's stamped `model_preference` -- and Kimi takes a LANE (`primary`|`secondary`), never
  a model id.

**The lanes ENGAGE only because the run loop binds them per-process.** A stamped
`model_preference` is inert until the secondary-model experiment is on for the process --
`kimiGoalInvocation` (the go.md step-6 Kimi run loop) sets `KIMI_CODE_EXPERIMENTAL_FLAG=1`
+ `KIMI_SECONDARY_MODEL` from the single derivation `kimiLaneEnv()` (`src/kimi.js`), and
the flag is also what selects the v2 engine under `kimi -p`. The interactive TUI ignores
`model_preference` entirely, so lanes bind under a muster-launched `kimi -p`, never in the
TUI (docs/research/kimi-code-cli.md sec 11.8). `muster doctor`'s `kimi-lane-binding` check
reports the active binding.

**Attended sessions cannot currently dispatch lane-sensitive legs as headless `kimi -p`
processes.** The
AgentSwarm/agent-calls shapes above are the UNATTENDED in-session path -- lanes bind there
only because `kimiGoalInvocation` (go.md step 6) already set the env pair for the whole run
loop. An ATTENDED/interactive session (a human driving this skill in the TUI) has no such
bind, and the TUI ignores `model_preference` entirely, so an in-session `Agent` call there
can never engage a lane. The intended Muster-owned supervisor interface remains
`$MUSTER_CLI kimi-process-run
--brief <text> --agent-file <name|path> --cwd <dir> --lane <primary|secondary>`
(`src/dispatch-receipts.js`), but it always exits nonzero before spawn, receipt, cgroup, or
signal setup because trusted broker bootstrap is unavailable. Therefore an attended
lane-sensitive leg is report-only: escalate the leg instead of running it. There is no
platform or prerequisite bypass. `$MUSTER_CLI kimi-process-dispatch ...` remains descriptor-only
compatibility/debug output and MUST NOT be manually spawned; it does not enable a production
leg. Filesystem receipts are diagnostic only and never authorize hygiene signaling, including
valid same-UID fabrications; receipt directory enumeration and each compaction pass are globally
capped even under malformed-name flooding, retention converges to 128 receipts, and compaction
unlinks only non-followed entries beneath an open receipt-directory descriptor. The descriptor's
`argv` is `["-p", <bounded file-bootstrap prompt>, "--agent-file", <absolute agent file>,
"--output-format", "stream-json", "-m", KIMI_LANES[lane]]`, and `env` is the shared
`kimiLaneEnv()` OVERRIDE pair, carried for the v2 engine flag `--agent-file` needs (its
`KIMI_SECONDARY_MODEL` half also binds lanes for any subagents the leg itself spawns) --
`-m` is ALWAYS
emitted, for the primary lane too: `model_preference` binds only a process's SPAWNED
SUBAGENTS, never the `-p` process's own main agent, so the process's model comes ONLY from
`-m` and omitting it silently falls to config `default_model`. The descriptor records this
as `briefTransport: { kind: "temporary-file", encoding: "utf8", maxBytes: 65536 }`:
`withKimiProcessBriefFile` writes the complete brief to an ephemeral temporary directory,
substitutes only its path into the bounded `-p` bootstrap, requires the launcher to return a
Promise that settles after child exit, and recursively removes the directory after that Promise
settles or rejects. The descriptor is module-branded and its transport/argv surfaces are frozen;
the helper independently revalidates the byte cap and argv template. This file transport is cross-platform and does
not inherit `/goal`'s unrelated 4,000-character objective limit or Windows' command-line size.
Briefs MUST be secret-free: the mode is a POSIX hardening hint, not a Windows ACL or a
confidentiality boundary, and the model consumes their contents. If a future trusted
broker enables this interface, its execution receipt must be
the stream-json result on stdout plus the process exit code, with per-leg token accounting
from `$MUSTER_CLI kimi-session-usage --cwd <leg cwd> --stdout-file <captured stdout file>`
(src/kimi-receipts.js's `readSessionUsage`, reached through
`captureSessionId`/`resolveSessionForCwd`) over the fresh session dir the process writes
(docs/research/kimi-code-cli.md sec 8). Reserve the attended session's native `Agent` tool
for legs that genuinely need the parent's live context; the pre-validation, resume-retry,
and background rules below keep governing the unattended in-session path, which a process
lane never replaces mid-loop.

**Pre-validate the four swarm rejection rules BEFORE dispatch -- never pay a whole-wave
round trip to learn them.** Kimi rejects a malformed swarm before any subagent starts, so
a bad packet costs the wave's entire fan-out. `kimiSwarmCall` enforces all four up front
and throws with the offending detail named: (1) at least 2 items unless resuming; (2)
`prompt_template` required whenever items are present; (3) the template must contain the
exact `{{item}}` placeholder; (4) -- absent from Kimi's published docs, enforced in the
binary -- the FILLED prompts must be DISTINCT: two items expanding to the same prompt
reject the WHOLE swarm, and duplicate wave items (two crew members handed the same file)
are exactly how muster would trip it. On a validation error, FIX the packet (rename or
merge the duplicate item, repair the template) and rebuild; a wave that cannot satisfy the
distinct-prompts rule is not a uniform fan-out at all -- resolve it as agent-calls instead.

**Failure retry rides the same native shapes.** Step 4a's re-dispatch-once rule RESUMES on
Kimi instead of re-spawning (docs/research/kimi-code-cli.md sec 6): a failed per-agent call is
retried as `kimiAgentCall({ resume: <failed agent id>, prompt: <error context> })` -- Kimi's
`resume` is mutually exclusive with `subagent_type`, and a resumed subagent keeps its model, so
the retry packet drops the lane override too; a failed swarm member is retried as
`kimiSwarmCall({ resumeAgentIds: { <failed agent id>: <error context> } })` -- which is also why
the >=2-item floor lifts when resuming. One retry, the same cap every harness gets; a second
failure escalates exactly as step 4a says.

**Background a leg only when the wave does not barrier on it.** An independent read-only
leg -- a reviewer whose verdict does not gate the CURRENT wave, an investigator whose
findings only a later wave (or the deferred fast-path review pass) needs -- dispatches as
`kimiAgentCall({ ..., background: true })` (`run_in_background`): the call returns a task id
immediately and the orchestrator keeps making progress, with the leg's result folding back
from the background-completion receipt -- a synthetic user message carrying the subagent's
final message (the whole handoff, same return contract as a foreground leg), backed by the
on-disk `tasks/<task_id>.json` + `output.log` (docs/research/kimi-code-cli.md secs 6+8;
`interpretKimiBackgroundCompletion` in `src/kimi-dispatch.js` maps the receipt onto the
fold-back, and a failed backgrounded leg re-enters step 4a's re-dispatch-once rule
unchanged). Anything step 4b's barrier or step 4c's review gate depends on dispatches
FOREGROUND: a backgrounded leg is still in flight at the barrier, so backgrounding
barrier-gated work would silently empty the barrier's "all wave tasks done" meaning.
AgentSwarm needs no background mode -- the swarm IS the barrier.
