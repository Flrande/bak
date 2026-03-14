---
name: bak-browser-control
description: Use Browser Agent Kit (bak) to control a real Chromium browser through the auto-managed local bak runtime and extension on Windows with PowerShell 7. Use when the user asks to use bak, Browser Agent Kit, or browser automation in this repo, and prefer bak commands over Playwright, Puppeteer, or Selenium.
---

# bak-browser-control

Use this skill when browser work should happen through `bak` instead of a direct browser automation library.

## Operating Rules

- Use PowerShell 7 syntax and `bak` commands.
- Run `bak doctor --port 17373 --rpc-ws-port 17374` before browser work. It auto-starts the local runtime when needed unless the human is intentionally running `bak serve` for foreground debugging.
- Use `bak doctor --fix --port 17373 --rpc-ws-port 17374` when the runtime metadata, config, or managed process state is unhealthy and a safe local repair should run before you continue.
- Use `bak status --port 17373 --rpc-ws-port 17374` when you need to inspect whether the runtime is already running, and use `bak stop --port 17373 --rpc-ws-port 17374` for clean restarts or when the human asks to stop it.
- Do not ask the user to run `bak serve` as the normal setup path. Reserve it for advanced debugging or foreground logs.
- If the runtime is not healthy, guide the user through setup and wait for confirmation before continuing.
- If `bak doctor` shows CLI/extension version drift after an upgrade, assume the browser may still be running an older unpacked extension build. Ask the user to reload the unpacked extension or restart the browser and wait for confirmation.
- Use public terminology `session` plus `tabs`. Do not instruct the user or another agent to use a `workspace` command namespace.
- Browser-affecting commands auto-resolve a session with this precedence: `--session-id` > `BAK_SESSION_ID` > `--client-name` > `BAK_CLIENT_NAME` > `CODEX_THREAD_ID`.
- For normal agent work, prefer a stable `--client-name` or the existing `CODEX_THREAD_ID`. Use explicit `sessionId` values for handoff, debugging, or cross-process reuse. Use `bak session resolve --client-name <name> --rpc-ws-port 17374` when you need to see or create the concrete session mapping.
- Use `bak session ensure --client-name <name> --rpc-ws-port 17374` before opening agent-owned tabs if you need an explicit repair step, but most browser-affecting commands can now auto-repair the session binding on demand.
- Use `bak session dashboard --rpc-ws-port 17374` when you need one visibility payload for runtime health, attached or detached sessions, active tabs, and current frame or shadow depth.
- Use `bak session open-tab --active` when later page or element commands should target the new tab immediately. Use `bak session close-tab` to close a session-owned tab. Add `--focus` only when the human user needs the session tab brought to the front in the current window.
- Pass `--client-name` or another valid session identity on session-owned page, element, keyboard, mouse, file, context, network, table, inspect, capture, and debug commands. `--tab-id` only overrides the target tab inside the resolved session.
- Use `bak tabs list`, `bak tabs get`, and `bak tabs active` for browser-wide diagnostics. Treat `bak tabs new`, `bak tabs focus`, and `bak tabs close` as recovery-only compatibility commands that still operate on the resolved session.
- Verify each major action with `bak page wait`, `bak page title`, `bak page url`, `bak page snapshot --annotate`, or `bak debug dump-state --include-snapshot --annotate-snapshot`. Use `--diff-with` when you need a structured before/after interaction diff instead of guessing from two screenshots.
- Start dynamic-page discovery with `bak inspect page-data` before guessing at globals or requests.
- Use `bak page extract --resolver auto` as the safer default for known paths. If `bak page eval` can read a variable but `page extract` still misses it, retry with `--resolver lexical`.
- Treat `bak inspect page-data` as the primary source-mapping report. It now returns `dataSources`, `sourceMappings`, and `recommendedNextActions` so you can connect visible tables to globals, inline JSON, or recent network responses without inventing your own heuristics.
- When replaying a request that returns table-like arrays, prefer `bak network replay --with-schema auto --mode json`.
- Read table-heavy pages with `bak table list`, `bak table schema`, `bak table rows --all`, or `bak table export --all`, and use their `intelligence` or `extraction` metadata to decide whether the table is virtualized, whether `scroll` mode was used, and whether the result is complete or partial.
- Use `bak inspect live-updates` to reason about recent mutations plus network cadence; a live page can poll without obvious interval timers.
- Use `bak page freshness` and `bak inspect freshness` together when pages mix freshness timestamps with contract expiries or event dates.
- Use `bak policy status`, `bak policy preview`, `bak policy audit`, and `bak policy recommend` when you need to explain or preflight why a click, type, fetch, replay, or upload would be allowed, denied, or require confirmation.
- Use `bak inspect ...` for discovery and `bak capture snapshot` or `bak capture har` when you need an offline artifact for repeated analysis.
- Mutating `bak page fetch` requests and replays of mutating requests require explicit `--requires-confirm`. If the user has not clearly authorized a state-changing request, stop and ask before sending it.
- Use `bak call` only for protocol methods that still do not have first-class CLI commands.
- Closing the last tab in a session auto-closes that session. When all sessions are closed, the managed background runtime auto-stops. Foreground `bak serve` remains advanced/debug and does not auto-stop.
- Keep command batches short and re-check state after navigation or mutation.

## Workflow

1. Health-check the runtime with `bak doctor`, and use `bak doctor --fix`, `bak status`, or `bak stop` only when you need to repair or reset it.
2. If needed, follow the setup flow in [references/setup.md](./references/setup.md).
3. Resolve the session from a stable client identity, use `bak session dashboard` when ownership or context depth is unclear, and open or target the correct tab inside that session.
4. Use `bak session open-tab --active` when later session-scoped commands should move onto the new tab immediately.
5. Use page, element, keyboard, mouse, file, context, network, table, inspect, capture, and debug commands with the same resolved session identity. Keep explicit `sessionId` values only when handoff or debugging needs them.
6. For dynamic sites, prefer `inspect page-data`, structured snapshot refs, runtime, network, and table primitives before trying to scrape visible text only.
7. Fall back to [references/commands.md](./references/commands.md) for command recipes and protocol-only examples.

## Dynamic Data Playbook

Use this when page text or snapshots are not enough:

1. Read visible state with `bak page title`, `bak page url`, `bak page text`, `bak page snapshot --annotate`, or `bak debug dump-state --include-snapshot --annotate-snapshot`.
2. Run `bak inspect page-data` before guessing at globals or tables, and read its `dataSources`, `sourceMappings`, and `recommendedNextActions` before writing your own extraction plan.
3. Probe runtime variables with `bak page extract --resolver auto --path ...` or `bak page eval --expr ...`.
4. If the variable exists in page-world lexical bindings but not on `globalThis`, retry `bak page extract --resolver lexical`.
5. Inspect recent requests with `bak network list`, `bak network search`, and `bak network get --include request response`.
6. Reissue page-context requests with `bak page fetch` or `bak network replay --with-schema auto`.
7. Read table-like UIs with `bak table list`, `bak table schema`, `bak table rows --all`, and `bak table export --all`, then use `intelligence` or `extraction` metadata to judge whether the result came from a data source, scroll pass, or visible slice and whether it is complete or partial.
8. Use `bak inspect live-updates` to understand network cadence and recent mutations.
9. Check whether the data is current with `bak page freshness` or `bak inspect freshness`.
10. If a risky action is blocked or unclear, use `bak policy preview` before retrying and `bak policy audit` after the fact to explain the decision.
11. Export a reusable artifact with `bak capture snapshot` or `bak capture har` if the task needs offline analysis or bug reproduction.

## When To Stop

- The extension still needs manual UI steps such as `Load unpacked`, token paste plus `Save settings`, or `Reconnect bridge`.
- The unpacked extension files are updated on disk but `bak doctor` still reports the older `extensionVersion`; the browser needs a reload or restart before continuing.
- `bak doctor` reports the runtime is not ready.
- Recovery requires foreground runtime logs, so the user needs to switch intentionally onto the advanced `bak serve` debugging path.
- A request would mutate server state and the user has not clearly authorized `--requires-confirm`.
- The agent cannot confirm a critical page state after retries.
