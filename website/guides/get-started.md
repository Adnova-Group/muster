# Get started

Choose the harness where you want Muster to run. The deterministic CLI is shared, but installation,
parallelism, isolation, and enforcement belong to the active harness.

<div class="harness-picker">

<a class="harness-card" href="./install">
  <span class="harness-card__eyebrow">Native CLI lane</span>
  <strong>Claude Code</strong>
  <span>Ten slash-command modes, plugin hooks, native agents, and native worktrees.</span>
  <span class="harness-card__action">Install for Claude Code →</span>
</a>

<a class="harness-card" href="./codex">
  <span class="harness-card__eyebrow">Native CLI lane</span>
  <strong>Codex</strong>
  <span>Ten skill modes, scoped profiles, advisory hooks, and receipted worktrees.</span>
  <span class="harness-card__action">Install for Codex →</span>
</a>

<a class="harness-card" href="./kimi">
  <span class="harness-card__eyebrow">Native CLI lane</span>
  <strong>Kimi</strong>
  <span>Ten namespaced skills, native subagents, permission rules, and explicit Init limits.</span>
  <span class="harness-card__action">Install for Kimi →</span>
</a>

<a class="harness-card" href="./cowork">
  <span class="harness-card__eyebrow">Local MCP lane</span>
  <strong>Cowork</strong>
  <span>Deterministic MCP tools with a verified sequential path and proof before parallel use.</span>
  <span class="harness-card__action">Connect Cowork →</span>
</a>

<a class="harness-card harness-card--conditional" href="./chatgpt-work">
  <span class="harness-card__eyebrow">Private/local · proof-gated</span>
  <strong>ChatGPT Work</strong>
  <span>Conditional developer lane through Secure MCP Tunnel. Requires a separately billed OpenAI Platform API key; a configured connection alone is not proof of native invocation.</span>
  <span class="harness-card__action">Review Work requirements →</span>
</a>

</div>

::: info Cost and service boundary
Muster's CLI makes no model calls. Claude Code, Codex, Kimi, and Cowork use the account or
subscription of their active native harness and do not require a Muster-hosted runtime. ChatGPT Work
is the documented exception: its private/local transport uses Secure MCP Tunnel and a separately
billed OpenAI Platform API key, distinct from a ChatGPT subscription.
:::

Already installed? Use the [task-to-mode quickstart](/guides/quickstart#choose-a-mode-by-task).
For side-by-side capability details, see [Harness support](/guides/harnesses).
