# Security policy

## Supported releases

Security fixes are made for the current minor release. Users should update to the latest patch in that minor. Older minors and prereleases are not supported unless a release note says otherwise.

## Report a vulnerability

Use GitHub private vulnerability reporting for this repository. Open the repository's Security tab, choose "Report a vulnerability," and create a private security advisory. Do not open a public issue for a suspected vulnerability.

Include the affected version, impact, reproduction steps, and the smallest useful proof of concept. Output from `muster doctor` can help, but redact usernames, home and project paths, repository names, connector names, tokens, and other private configuration before attaching it.

We aim to acknowledge a report within three business days and provide an initial assessment within ten business days. Complex reports may take longer, but we will keep the reporter informed.

## Disclosure

Please keep the report under embargo while we investigate and prepare a fix. We will coordinate disclosure timing and credit with the reporter. If we cannot agree on a date, allow at least 90 days from acknowledgement before public disclosure unless active exploitation requires a shorter timeline.

## Uncontained Codex waves (operator only)

Production Codex waves run inside bubblewrap on Linux. Its `tmpfs` masks keep `~/.codex` (including `auth.json`) and the fix-loop receipt key away from the worker. On macOS, Windows, or a Linux host without working bubblewrap, `codex-wave` refuses to run. That refusal is the safe outcome. Do not get around it by re-hosting the wave in a container, VM, or remote Linux host, or by forwarding `CODEX_HOME` into one. Doing that removes the very masking the refusal protects.

On macOS, or on Linux without working bubblewrap, an operator who accepts a degraded run can create this file. Windows is not supported, because ownership of the file cannot be verified there.

```bash
mkdir -p ~/.config/muster
printf '%s\n' i-accept-no-process-containment > ~/.config/muster/uncontained-wave
chmod 600 ~/.config/muster/uncontained-wave
```

`~` here is your home directory as recorded in the system user database. `HOME` and `XDG_CONFIG_HOME` are ignored, because the agent that launches the wave can set either one.

The file is honoured only if all of the following hold. Otherwise the wave is refused and the refusal names the failed check:

- It is a regular file with a single link, owned by you, and no component of its path is a symlink.
- Neither the file nor its directory is group- or world-writable.
- It resolves outside the repository, its git directory, every member worktree, and the system temp directories (`/tmp`, `/var/tmp`, `$TMPDIR`).
- It contains exactly the sentence above.

A degraded wave runs under Codex's own `workspace-write` sandbox and reports `containment: "none"`. It loses:

- The credential masks: the worker can read `~/.codex/auth.json`.
- The PID namespace.
- The pinned-cwd bind.
- Resumability: the wave mints no receipt key. Before the worker launches, it also deletes any key left by earlier contained waves, in both the store it uses and the default store under `CODEX_HOME`. Those earlier waves can then no longer be resumed.

Do not run a contained wave or a `codex-wave-resume` at the same time as a degraded wave. That run would mint a new receipt key while the unmasked worker is able to read it.

The acknowledgement is ignored wherever bubblewrap works. Delete the file when you no longer need it.

This file is not a security boundary against software running as your user. It makes the degraded lane a deliberate operator act, so an agent cannot switch it on with an environment variable or by reflex. An agent that sets out to write the file can still do so. Agents driving muster are instructed to report the refusal and leave the file to you.
