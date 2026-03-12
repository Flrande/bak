# Agent Handoff

Use one of the three handoff paths below. Do not ask the agent to read the entire docs tree.

## 1. Preferred: Repo Skill

If the agent supports skills, give it:

- [../../skills/bak-browser-control/SKILL.md](../../skills/bak-browser-control/SKILL.md)

That skill is the repo-local execution guide for `bak`. It already encodes the current session model, the auto-managed runtime flow, the dynamic-data escalation path, and extension-reload stop conditions.

## 2. URL-Based Bootstrap

If the agent only accepts a guide URL, give it:

```text
https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md
```

Use this path when the agent needs to learn how to install, upgrade, verify, and recover the auto-managed runtime from a single page.

## 3. Plain Prompt Fallback

If the agent accepts only free-form instructions, give it:

```text
Use BAK CLI for browser work.

Environment:
- OS: Windows
- Shell: PowerShell 7
- CLI command: bak
- RPC WebSocket port: 17374

Rules:
1. Run `bak doctor --port 17373 --rpc-ws-port 17374` before browser work. It auto-starts the local runtime when needed unless the user is intentionally running `bak serve` for debugging.
2. Use `bak status --port 17373 --rpc-ws-port 17374` when you need to inspect whether the runtime is already up, and use `bak stop --port 17373 --rpc-ws-port 17374` for clean restarts or when the user asks to stop it.
3. If the runtime is not healthy, or if `summary.warningChecks` contains `versionCompatibility`, guide the user through extension setup or unpacked-extension reload and wait for confirmation.
4. Browser-affecting commands auto-resolve a session with this precedence: `--session-id` > `BAK_SESSION_ID` > `--client-name` > `BAK_CLIENT_NAME` > `CODEX_THREAD_ID`.
5. For normal agent work, use a stable `--client-name` or rely on `CODEX_THREAD_ID`. Use explicit `sessionId` values only for handoff, debugging, or cross-process reuse. `bak session resolve --client-name <name> --rpc-ws-port 17374` is the visibility/debug command when you need to see the exact session mapping.
6. Use `bak session resolve` when you need to inspect the concrete mapping, then use `bak session ensure` or `bak session open-tab --active` when later commands should target the new tab immediately. `bak session close-tab` closes a session-owned tab. `bak tabs list`, `bak tabs get`, and `bak tabs active` remain browser-wide diagnostics. `bak tabs new`, `bak tabs focus`, and `bak tabs close` are recovery-only compatibility commands that operate on the resolved session.
7. Verify major actions with `bak page wait`, `bak page url`, `bak page title`, `bak page snapshot`, or `bak debug dump-state`.
8. When data is missing from visible DOM, start with `bak inspect page-data`, then use `bak page extract --resolver auto` or `bak page eval`, then `bak network search/get`, then `bak page fetch` or `bak network replay --with-schema auto`, then `bak table rows --all`, then `bak page freshness` or `bak inspect live-updates`.
9. If `bak page fetch` or `bak network replay` would send a mutating request, require explicit user authorization and include `--requires-confirm`.
10. Use `bak capture snapshot` or `bak capture har` when you need a reusable offline artifact.
11. Use `bak call --method ... --params ...` only for protocol methods without first-class CLI commands.
12. Closing the last tab in a session auto-closes that session. When all sessions are closed, the managed background runtime auto-stops. Foreground `bak serve` is advanced/debug only and does not auto-stop.
13. Do not claim success until a verification command confirms the state.
```
