# Architecture

## System Overview

BAK connects a coding agent to a real Chromium tab through a local daemon and MV3 extension.

```text
Agent <-> CLI JSON-RPC (stdio/ws)
CLI daemon <-> Extension bridge websocket
Extension background <-> Content script (tab message passing)
Content script <-> DOM / events / page signals
```

## Main Packages

### `@bak/protocol`

- Source of truth for `MethodMap`, shared types, and error contracts.
- JSON schema lives in `packages/protocol/schemas/protocol.schema.json`.

### `@bak/cli`

- `packages/cli/src/server.ts`: daemon bootstrap (`ExtensionBridge`, `BakService`, `RpcServer`).
- `packages/cli/src/bin.ts`: command surface and user entrypoints.
- `packages/cli/src/service.ts`: RPC method handlers, tracing, memory orchestration.
- `packages/cli/src/drivers/*`: extension bridge + browser driver abstraction.

### `@bak/extension`

- `background.ts`: connection lifecycle, handshake, browser dispatch.
- `content.ts`: DOM interactions, waits, snapshots, user confirmation overlay, debug buffers.
- `popup.ts`: pairing config and runtime status.

## Runtime Data

Default root: `.bak-data` (override with `BAK_DATA_DIR`).

- traces: `.bak-data/traces/<traceId>.jsonl`
- snapshots: `.bak-data/snapshots/<traceId>/`
- memory: `.bak-data/memory.json` or `.bak-data/memory.sqlite`
- pairing token: `.bak-data/pairing.json`

## Memory Pipeline

1. `memory.recordStart` begins episode collection.
2. `memory.recordStop` stores episode and extracts a reusable skill.
3. `memory.skills.retrieve` ranks candidate skills by query context.
4. `memory.skills.run` replays steps with parameter substitution and healing.

## Driver Model

- Current implementation: `ExtensionDriver`
- Interface designed for additional backends (for example CDP/Playwright in future)
