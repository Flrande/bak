# Agent Handoff

Use one of the three handoff paths below. Do not ask the agent to read the entire docs tree.

## 1. Preferred: Repo Skill

If the agent supports skills, give it:

- [../../skills/bak-browser-control/SKILL.md](../../skills/bak-browser-control/SKILL.md)

That skill is the repo-local execution guide for `bak`. It already encodes the current session model, `bak doctor --fix`, `bak session dashboard`, multimodal snapshot verification, the policy workflow, the dynamic-data escalation path, and extension-reload stop conditions.

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
2. If `bak doctor` reports stale runtime metadata, a stopped managed runtime, or another safe local repairable state, run `bak doctor --fix --port 17373 --rpc-ws-port 17374` before escalating to manual recovery.
3. Use `bak status --port 17373 --rpc-ws-port 17374` when you need to inspect whether the runtime is already up, and use `bak stop --port 17373 --rpc-ws-port 17374` for clean restarts or when the user asks to stop it.
4. If the runtime is not healthy, or if `summary.warningChecks` contains `versionCompatibility`, guide the user through extension setup or unpacked-extension reload and wait for confirmation.
5. Browser-affecting commands auto-resolve a session with this precedence: `--session-id` > `BAK_SESSION_ID` > `--client-name` > `BAK_CLIENT_NAME` > `CODEX_THREAD_ID`.
6. For normal agent work, use a stable `--client-name` or rely on `CODEX_THREAD_ID`. Use explicit `sessionId` values only for handoff, debugging, or cross-process reuse. `bak session resolve --client-name <name> --rpc-ws-port 17374` is the visibility/debug command when you need to see the exact session mapping, and `bak session dashboard --rpc-ws-port 17374` is the fastest way to inspect runtime health plus per-session tab ownership and current context depth.
7. Use `bak session resolve` when you need to inspect the concrete mapping, then use `bak session ensure` or `bak session open-tab --active` when later commands should target the new tab immediately. `bak session close-tab` closes a session-owned tab. `bak tabs list`, `bak tabs get`, and `bak tabs active` remain browser-wide diagnostics. `bak tabs new`, `bak tabs focus`, and `bak tabs close` are recovery-only compatibility commands that operate on the resolved session.
8. Verify major actions with `bak page wait`, `bak page url`, `bak page title`, `bak page snapshot --annotate`, or `bak debug dump-state --include-snapshot --annotate-snapshot`. Use `--diff-with` when a structured before/after interaction diff is more useful than two screenshots.
9. When data is missing from visible DOM, start with `bak inspect page-data` and read its `dataSources`, `sourceMappings`, and `recommendedNextActions`, then use `bak page extract --resolver auto` or `bak page eval`, then `bak network search/get`, then `bak page fetch` or `bak network replay --with-schema auto`, then `bak table list/schema/rows/export` and their `intelligence` or `extraction` metadata, then `bak page freshness` or `bak inspect live-updates`.
10. Use `bak policy status` and `bak policy preview` when you need to explain or preflight why a risky click, type, fetch, replay, or upload would be allowed, denied, or require confirmation. Use `bak policy audit` or `bak policy recommend` to review recent decisions or derive conservative rule suggestions.
11. If `bak page fetch` or `bak network replay` would send a mutating request, require explicit user authorization and include `--requires-confirm`.
12. Use `bak capture snapshot` or `bak capture har` when you need a reusable offline artifact.
13. Use `bak call --method ... --params ...` only for protocol methods without first-class CLI commands.
14. Closing the last tab in a session auto-closes that session. When all sessions are closed, the managed background runtime auto-stops. Foreground `bak serve` is advanced/debug only and does not auto-stop.
15. Do not claim success until a verification command confirms the state.
```
