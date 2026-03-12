# User Docs

Use these pages by job, not in bulk.

## Install, Upgrade, Or Verify

- [quickstart.md](./quickstart.md)

`quickstart.md` is the only source of truth for installing the packages, loading the unpacked extension, upgrading it, and verifying or resetting the auto-managed runtime with `bak doctor`, `bak status`, and `bak stop`.

## Daily Use

- [cli-guide.md](./cli-guide.md)

`cli-guide.md` covers the day-to-day session-first workflow, auto-session resolution, recovery-only `tabs` commands, and the normal runtime lifecycle commands.

## Recovery And Troubleshooting

- [troubleshooting.md](./troubleshooting.md)

## Hand This Repo To An Agent

- [agent-prompts.md](./agent-prompts.md)
- [../../skills/bak-browser-control/SKILL.md](../../skills/bak-browser-control/SKILL.md)

These handoff docs assume agents normally rely on auto-resolved sessions through `--client-name`, `BAK_CLIENT_NAME`, or `CODEX_THREAD_ID`. Explicit `sessionId` values are still documented for handoff and debugging.
