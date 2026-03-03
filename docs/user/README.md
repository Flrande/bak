# User Docs

This section is for people using a coding agent to control a real browser.

## Agent-First Default

Paste this URL to your agent:

- `https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md`

That quickstart is the canonical setup path.

## Read In Order

1. [Quickstart](./quickstart.md): bootstrap, pairing, first successful browser control.
2. [CLI Guide](./cli-guide.md): command map and daily runtime usage.
3. [Memory Guide](./memory-guide.md): record and replay repeated web tasks.
4. [Troubleshooting](./troubleshooting.md): diagnose runtime and connection issues.
5. [Agent Prompts](./agent-prompts.md): reusable instruction templates.

## Package Names

- `@flrande/bak-cli`
- `@flrande/bak-extension`

## Style

- Commands are written for Windows + PowerShell 7.
- Global `bak` commands are the default; `npx bak` is a fallback when PATH is missing.
