# Browser Agent Kit (bak)

Browser Agent Kit is a browser extension plus a CLI for coding-agent browser control.

The product model is simple:
- the user installs the MV3 extension in a real Chromium browser
- the user runs the `bak` CLI daemon locally
- the agent drives the real browser through first-class CLI commands or JSON-RPC
- memory is explicit and advisory, not automatic

## What Ships

- `packages/extension`: the paired browser extension
- `packages/cli`: the `bak` CLI, daemon, JSON-RPC server, and memory service
- `packages/protocol`: shared `v3` protocol types and schema
- `apps/test-sites`: local multi-page test app used by e2e coverage
- `tests`: unit and Playwright e2e coverage

## Core Capabilities

Browser control and reading:
- page snapshot, text, DOM, accessibility tree, metrics, viewport
- console, network, and structured debug dump
- `debug dump-state --include-snapshot` can attach a fresh viewport snapshot artifact to the structured dump
- console capture is structured but best-effort for page-origin logs; treat it as advisory rather than a guaranteed browser-devtools equivalent
- network capture is best-effort: when page-world request hooks are unavailable, `network.*` falls back to resource timing entries with `kind: "resource"` and `status: 0`
- frame context, shadow context, and frame+shadow combinations
- element read/write actions, keyboard, mouse, and file upload

Memory lifecycle:
- `capture begin -> capture mark -> capture end`
- only one capture session can be active at a time
- draft review before promotion
- durable memories with immutable revisions
- search returns candidates only
- search can rank against the active tab or an explicit URL
- explain returns applicability checks and risks
- plan creation binds parameters and checks fit
- execute runs a specific plan in `dry-run`, `assist`, or `auto`
- drift produces explicit patch suggestions instead of silent writeback
- captured element steps retain live locator candidates so later patch suggestions can match by name/text/role instead of only the original css

## Memory Model

The memory system is `v3` and intentionally breaks the old skill-centric model.

Durable memory kinds:
- `route`: how to reach a page, feature, or entry point
- `procedure`: how to complete a task on a page
- `composite`: an execution composition, usually route + procedure

Principles:
- no silent durable memory writes
- no silent recall
- no silent execution
- no silent mutation during replay
- capture/promote `route` memories explicitly when you want repeated path reuse, then search with `--kind route` and explain/plan against the current starting page before executing
- captured text stays literal unless it is already templated or clearly sensitive
- context-aware page metadata uses the active document for the current frame/shadow stack
- default execution mode is `assist`
- sqlite is the only supported durable memory backend

## Quick Start

```powershell
pnpm i
pnpm build
node packages/cli/dist/bin.js pair create
node packages/cli/dist/bin.js serve --port 17373 --rpc-ws-port 17374
```

Then load `packages/extension/dist` as an unpacked extension in Chrome or Edge, connect it with the popup, and verify:

```powershell
node packages/cli/dist/bin.js doctor --port 17373 --rpc-ws-port 17374
```

## CLI Examples

```powershell
node packages/cli/dist/bin.js page snapshot --include-base64 --rpc-ws-port 17374
node packages/cli/dist/bin.js debug dump-state --include-snapshot --rpc-ws-port 17374
node packages/cli/dist/bin.js context enter-frame --frame-path '#demo-frame' --rpc-ws-port 17374
node packages/cli/dist/bin.js element drag-drop --from-css '#drag-source' --to-css '#drop-target' --rpc-ws-port 17374
node packages/cli/dist/bin.js memory capture begin --goal "open billing settings" --rpc-ws-port 17374
node packages/cli/dist/bin.js memory search --goal "open billing settings" --kind route --url "https://portal.local/settings/billing" --rpc-ws-port 17374
node packages/cli/dist/bin.js memory explain <memoryId> --url "https://portal.local/home" --rpc-ws-port 17374
node packages/cli/dist/bin.js memory plan create --memory-id <memoryId> --mode assist --rpc-ws-port 17374
node packages/cli/dist/bin.js memory execute <planId> --rpc-ws-port 17374
```

## Build And Validation

```powershell
pnpm build
pnpm typecheck
pnpm test:unit
pnpm exec playwright test --reporter=line
```

## Documentation

- [docs/README.md](./docs/README.md)
- [docs/user/README.md](./docs/user/README.md)
- [docs/developer/README.md](./docs/developer/README.md)
- [docs/PROTOCOL.md](./docs/PROTOCOL.md)
- [docs/user/cli-guide.md](./docs/user/cli-guide.md)
- [docs/user/memory-guide.md](./docs/user/memory-guide.md)
