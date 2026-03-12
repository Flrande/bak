# Browser Agent Kit (`bak`)

`bak` lets a human set up a real Chromium browser for an agent through a local CLI daemon, a paired extension, and explicit session-owned browser state.

## Start Here

If you want to install `bak` for your own agent:

- Read [docs/user/quickstart.md](./docs/user/quickstart.md)

If you are handing this repo to an agent:

- Read [docs/user/agent-prompts.md](./docs/user/agent-prompts.md)
- Load [skills/bak-browser-control/SKILL.md](./skills/bak-browser-control/SKILL.md)

If you are onboarding as a contributor:

- Read [docs/developer/README.md](./docs/developer/README.md)

## What You Should Read Next

- Install, upgrade, and verify the runtime: [docs/user/quickstart.md](./docs/user/quickstart.md)
- Learn the day-to-day CLI surface: [docs/user/cli-guide.md](./docs/user/cli-guide.md)
- Recover from runtime or targeting problems: [docs/user/troubleshooting.md](./docs/user/troubleshooting.md)
- Browse the full docs map: [docs/README.md](./docs/README.md)

## Product Shape

- `bak session ...` is the default agent surface for dedicated browser state.
- `bak tabs ...` is the direct browser-wide tab surface outside the session helpers.
- `bak page`, `bak element`, `bak context`, `bak debug`, `bak network`, `bak table`, `bak inspect`, `bak capture`, `bak keyboard`, `bak mouse`, and `bak file` operate on the current session tab by default.
- `bak call` remains the fallback for protocol-only methods.

Public terminology is `session` plus `tabs`. Older `workspace` wording is obsolete in the user-facing CLI.
