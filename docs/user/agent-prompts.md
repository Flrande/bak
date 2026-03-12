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
4. Create a session with `bak session create --client-name <name> --rpc-ws-port 17374`, keep the returned `sessionId`, and use `bak session ensure --session-id <sessionId> --rpc-ws-port 17374` before opening agent-owned tabs.
5. Use `bak session open-tab --active` when later commands should target the new tab immediately. Use `bak tabs ...` only for direct browser-wide inspection or recovery.
6. Verify major actions with `bak page wait`, `bak page url`, `bak page title`, `bak page snapshot`, or `bak debug dump-state`.
7. When data is missing from visible DOM, start with `bak inspect page-data`, then use `bak page extract --resolver auto` or `bak page eval`, then `bak network search/get`, then `bak page fetch` or `bak network replay --with-schema auto`, then `bak table rows --all`, then `bak page freshness` or `bak inspect live-updates`.
8. If `bak page fetch` or `bak network replay` would send a mutating request, require explicit user authorization and include `--requires-confirm`.
9. Use `bak capture snapshot` or `bak capture har` when you need a reusable offline artifact.
10. Use `bak call --method ... --params ...` only for protocol methods without first-class CLI commands.
11. Do not claim success until a verification command confirms the state.
```
