---
name: bak-browser-control
description: Use Browser Agent Kit (bak) to control a real Chromium browser through the auto-managed local bak runtime and extension on Windows with PowerShell 7. Use when the user asks to use bak, Browser Agent Kit, or browser automation in this repo, and prefer bak commands over Playwright, Puppeteer, or Selenium.
---

# bak-browser-control

Use this skill when browser work should happen through `bak` instead of a direct browser automation library.

## Operating Rules

- Use PowerShell 7 syntax and `bak` commands.
- Run `bak doctor --port 17373 --rpc-ws-port 17374` before browser work. It auto-starts the local runtime when needed unless the human is intentionally running `bak serve` for foreground debugging.
- Use `bak status --port 17373 --rpc-ws-port 17374` when you need to inspect whether the runtime is already running, and use `bak stop --port 17373 --rpc-ws-port 17374` for clean restarts or when the human asks to stop it.
- Do not ask the user to run `bak serve` as the normal setup path. Reserve it for advanced debugging or foreground logs.
- If the runtime is not healthy, guide the user through setup and wait for confirmation before continuing.
- If `bak doctor` shows CLI/extension version drift after an upgrade, assume the browser may still be running an older unpacked extension build. Ask the user to reload the unpacked extension or restart the browser and wait for confirmation.
- Use public terminology `session` plus `tabs`. Do not instruct the user or another agent to use a `workspace` command namespace.
- Create a session explicitly with `bak session create --client-name <name> --rpc-ws-port 17374`, keep the returned `sessionId`, and use `bak session ensure --session-id <sessionId> --rpc-ws-port 17374` before opening agent-owned tabs.
- Use `bak session open-tab --active` when later page or element commands should target the new tab immediately. Add `--focus` only when the human user needs the session window brought forward.
- Pass `--session-id` on session-owned page, element, keyboard, mouse, file, context, network, table, inspect, capture, and debug commands unless an explicit `--tab-id` override is required.
- Use `bak tabs ...` only for browser-wide inspection, focusing, or recovery outside the current session-owned tab set.
- Verify each major action with `bak page wait`, `bak page title`, `bak page url`, `bak page snapshot`, or `bak debug dump-state`.
- Start dynamic-page discovery with `bak inspect page-data` before guessing at globals or requests.
- Use `bak page extract --resolver auto` as the safer default for known paths. If `bak page eval` can read a variable but `page extract` still misses it, retry with `--resolver lexical`.
- When replaying a request that returns table-like arrays, prefer `bak network replay --with-schema auto --mode json`.
- Use `bak inspect live-updates` to reason about recent mutations plus network cadence; a live page can poll without obvious interval timers.
- Use `bak page freshness` and `bak inspect freshness` together when pages mix freshness timestamps with contract expiries or event dates.
- Use `bak inspect ...` for discovery and `bak capture snapshot` or `bak capture har` when you need an offline artifact for repeated analysis.
- Mutating `bak page fetch` requests and replays of mutating requests require explicit `--requires-confirm`. If the user has not clearly authorized a state-changing request, stop and ask before sending it.
- Use `bak call` only for protocol methods that still do not have first-class CLI commands.
- Keep command batches short and re-check state after navigation or mutation.

## Workflow

1. Health-check the runtime with `bak doctor`, and use `bak status` or `bak stop` only when you need to inspect or reset it.
2. If needed, follow the setup flow in [references/setup.md](./references/setup.md).
3. Create the session, ensure the dedicated session window, and open or target the correct tab inside that session.
4. Use `bak session open-tab --active` when later session-scoped commands should move onto the new tab immediately.
5. Use page, element, keyboard, mouse, file, context, network, table, inspect, capture, and debug commands with the same `sessionId`.
6. For dynamic sites, prefer inspect, runtime, network, and table primitives before trying to scrape visible text only.
7. Fall back to [references/commands.md](./references/commands.md) for command recipes and protocol-only examples.

## Dynamic Data Playbook

Use this when page text or snapshots are not enough:

1. Read visible state with `bak page title`, `bak page url`, `bak page text`, or `bak debug dump-state`.
2. Run `bak inspect page-data` before guessing at globals or tables.
3. Probe runtime variables with `bak page extract --resolver auto --path ...` or `bak page eval --expr ...`.
4. If the variable exists in page-world lexical bindings but not on `globalThis`, retry `bak page extract --resolver lexical`.
5. Inspect recent requests with `bak network list`, `bak network search`, and `bak network get --include request response`.
6. Reissue page-context requests with `bak page fetch` or `bak network replay --with-schema auto`.
7. Read table-like UIs with `bak table list`, `bak table schema`, and `bak table rows --all`.
8. Use `bak inspect live-updates` to understand network cadence and recent mutations.
9. Check whether the data is current with `bak page freshness` or `bak inspect freshness`.
10. Export a reusable artifact with `bak capture snapshot` or `bak capture har` if the task needs offline analysis or bug reproduction.

## When To Stop

- The extension still needs manual UI steps such as `Load unpacked`, token paste, or popup connect.
- The unpacked extension files are updated on disk but `bak doctor` still reports the older `extensionVersion`; the browser needs a reload or restart before continuing.
- `bak doctor` reports the runtime is not ready.
- Recovery requires foreground runtime logs, so the user needs to switch intentionally onto the advanced `bak serve` debugging path.
- A request would mutate server state and the user has not clearly authorized `--requires-confirm`.
- The agent cannot confirm a critical page state after retries.
