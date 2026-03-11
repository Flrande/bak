---
name: bak-browser-control
description: Use Browser Agent Kit (bak) to control a real Chromium browser through the bak CLI daemon and extension on Windows with PowerShell 7. Use when the user asks to use bak, Browser Agent Kit, or browser automation in this repo, and prefer bak commands over Playwright, Puppeteer, or Selenium.
---

# bak-browser-control

Use this skill when browser work should happen through `bak` instead of a direct browser automation library.

## Operating Rules

- Use PowerShell 7 syntax and `bak` commands.
- Run `bak doctor --port 17373 --rpc-ws-port 17374` before browser work.
- If the runtime is not healthy, guide the user through setup and wait for confirmation before continuing.
- Use public terminology `session` plus `tabs`. Do not instruct the user or another agent to use a `workspace` command namespace.
- Create a session explicitly with `bak session create --client-name <name> --rpc-ws-port 17374`, keep the returned `sessionId`, and use `bak session ensure --session-id <sessionId> --rpc-ws-port 17374` before opening agent-owned tabs.
- Pass `--session-id` on session-owned page, element, keyboard, mouse, file, context, network, table, inspect, capture, and debug commands unless an explicit `--tab-id` override is required.
- Use `bak tabs ...` only for browser-wide inspection, focusing, or recovery outside the current session-owned tab set.
- Verify each major action with `bak page wait`, `bak page title`, `bak page url`, `bak page snapshot`, or `bak debug dump-state`.
- When the visible DOM is incomplete, escalate in this order: `bak page extract` or `bak page eval`, then `bak network search` or `bak network get`, then `bak page fetch` or `bak network replay`, then `bak table rows`, then `bak page freshness`.
- Use `bak inspect ...` for discovery and `bak capture snapshot` or `bak capture har` when you need an offline artifact for repeated analysis.
- Mutating `bak page fetch` requests and replays of mutating requests require explicit `--requires-confirm`. If the user has not clearly authorized a state-changing request, stop and ask before sending it.
- Use `bak call` only for protocol methods that still do not have first-class CLI commands.
- Keep command batches short and re-check state after navigation or mutation.

## Workflow

1. Health-check the runtime.
2. If needed, follow the setup flow in [references/setup.md](./references/setup.md).
3. Create the session, ensure the session binding, and open or target the correct tab inside that session.
4. Use page, element, keyboard, mouse, file, context, network, table, inspect, capture, and debug commands with the same `sessionId`.
5. For dynamic sites, prefer runtime and network primitives before trying to scrape visible text only.
6. Fall back to [references/commands.md](./references/commands.md) for command recipes and protocol-only examples.

## Dynamic Data Playbook

Use this when page text or snapshots are not enough:

1. Read visible state with `bak page title`, `bak page url`, `bak page text`, or `bak debug dump-state`.
2. Probe runtime variables with `bak page extract --path ...` or `bak page eval --expr ...`.
3. Inspect recent requests with `bak network list`, `bak network search`, and `bak network get --include request response`.
4. Reissue page-context requests with `bak page fetch` or `bak network replay`.
5. Read table-like UIs with `bak table list`, `bak table schema`, and `bak table rows --all`.
6. Check whether the data is current with `bak page freshness` or `bak inspect freshness`.
7. Export a reusable artifact with `bak capture snapshot` or `bak capture har` if the task needs offline analysis or bug reproduction.

## When To Stop

- The extension still needs manual UI steps such as `Load unpacked`, token paste, or popup connect.
- `bak doctor` reports the runtime is not ready.
- A request would mutate server state and the user has not clearly authorized `--requires-confirm`.
- The agent cannot confirm a critical page state after retries.
