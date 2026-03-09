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
- Create or repair the agent workspace explicitly with `bak workspace ensure --rpc-ws-port 17374`.
- Verify each major action with `bak page wait`, `bak page title`, `bak page url`, `bak page snapshot`, or `bak debug dump-state`.
- Use `bak call` for protocol methods that do not have first-class CLI commands.
- Keep command batches short and re-check state after navigation or mutation.

## Workflow

1. Health-check the runtime.
2. If needed, follow the setup flow in [references/setup.md](./references/setup.md).
3. Ensure the workspace and open or target the correct tab.
4. Use page, element, keyboard, mouse, file, context, debug, network, and memory commands as needed.
5. Fall back to [references/commands.md](./references/commands.md) for command recipes and protocol-only examples.

## When To Stop

- The extension still needs manual UI steps such as `Load unpacked`, token paste, or popup connect.
- `bak doctor` reports the runtime is not ready.
- The agent cannot confirm a critical page state after retries.
