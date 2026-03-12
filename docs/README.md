# Docs

Use this page as the docs router for `bak` and its auto-managed runtime flow.

## I Want To Install `bak` For My Agent

- Start with [user/quickstart.md](./user/quickstart.md)
- Then use [user/cli-guide.md](./user/cli-guide.md)
- If something breaks, use [user/troubleshooting.md](./user/troubleshooting.md)

`quickstart.md` covers the normal runtime lifecycle: let `bak doctor` auto-start the local runtime when needed, use `bak status` to inspect it, and use `bak stop` when you want a clean restart. `bak serve` is reserved for advanced debugging.

## I Am Handing `bak` To An Agent

- Start with [user/agent-prompts.md](./user/agent-prompts.md)
- Then load [../skills/bak-browser-control/SKILL.md](../skills/bak-browser-control/SKILL.md)

Those handoff docs and the repo skill both assume the same auto-managed runtime model.

## I Am Onboarding As A Developer

- Start with [developer/README.md](./developer/README.md)

## Reference Material

- Protocol surface: [PROTOCOL.md](./PROTOCOL.md)
- Product behavior and architecture: [TECH_SPEC.md](./TECH_SPEC.md)
- Generated reports and low-change references: [reference/README.md](./reference/README.md)
