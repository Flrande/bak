# Browser Agent Kit (`bak`)

`bak` lets a human set up a real Chromium browser for an agent through an auto-managed local runtime, a paired extension, and explicit session-owned browser state.

## Start Here

If you want to install `bak` for your own agent:

- Read [docs/user/quickstart.md](./docs/user/quickstart.md)

If you are handing this repo to an agent:

- Read [docs/user/agent-prompts.md](./docs/user/agent-prompts.md)
- Load [skills/bak-browser-control/SKILL.md](./skills/bak-browser-control/SKILL.md)

If you are onboarding as a contributor:

- Read [docs/developer/README.md](./docs/developer/README.md)

## What You Should Read Next

- Install, upgrade, and verify the auto-managed runtime: [docs/user/quickstart.md](./docs/user/quickstart.md)
- Learn the day-to-day CLI surface: [docs/user/cli-guide.md](./docs/user/cli-guide.md)
- Recover from runtime or targeting problems: [docs/user/troubleshooting.md](./docs/user/troubleshooting.md)
- Browse the full docs map: [docs/README.md](./docs/README.md)

## Product Shape

- `bak session ...` is the default agent surface for dedicated browser state. `bak session resolve` is the normal way to find-or-create that state from a stable client identity, and `bak session close-tab` is the normal way to close a session-owned tab.
- Browser-affecting commands auto-resolve a session with this precedence: `--session-id` > `BAK_SESSION_ID` > `--client-name` > `BAK_CLIENT_NAME` > `CODEX_THREAD_ID`.
- `bak page`, `bak element`, `bak context`, `bak debug`, `bak network`, `bak table`, `bak inspect`, `bak capture`, `bak keyboard`, `bak mouse`, and `bak file` operate on the current resolved session tab by default.
- `bak tabs list`, `bak tabs get`, and `bak tabs active` remain browser-wide diagnostics.
- `bak tabs new`, `bak tabs focus`, and `bak tabs close` are recovery-only compatibility commands that operate on the resolved session, not arbitrary browser tabs.
- Closing the last tab in a session auto-closes that session. When all sessions are closed, the managed background runtime auto-stops. Foreground `bak serve` remains an advanced debug path and does not auto-stop.
- Explicit `sessionId` values are still useful for handoff, debugging, and cross-process reuse, but they are no longer the default agent workflow.
- `bak call` remains the fallback for protocol-only methods.

Public terminology is `session` plus `tabs`. Older `workspace` wording is obsolete in the user-facing CLI.

## Recent Operator Surfaces

- Runtime recovery and visibility: `bak doctor --fix` repairs safe local runtime/config drift, and `bak session dashboard` gives one JSON view of runtime health plus per-session tab ownership and current frame or shadow depth.
- Multimodal page verification: `bak page snapshot --annotate` and `bak debug dump-state --include-snapshot --annotate-snapshot` return numbered `@eN` refs plus `actionSummary`, and `--diff-with` adds structured before/after interaction diffs.
- Policy workflow: `bak policy status`, `bak policy preview`, `bak policy audit`, and `bak policy recommend` expose the current safety posture, dry-run decisions, recent policy traces, and conservative rule suggestions without silently rewriting `.bak-policy.json`.
- Dynamic data intelligence: `bak inspect page-data` now reports `dataSources`, `sourceMappings`, and `recommendedNextActions`, while `bak table list/schema/rows/export` surface `intelligence` or `extraction` metadata so agents can tell whether a virtualized table read is complete or partial.
