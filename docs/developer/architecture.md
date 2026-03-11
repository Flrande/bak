# Architecture

## Major Components

- Extension: content script, background worker, popup pairing UI, overlay confirmation flow
- CLI: daemon, RPC server, browser driver abstraction, policy checks, diagnostics, local artifact persistence
- Protocol: shared request/response types and schema
- Test app: browser fixtures that exercise workspace, context, and debug flows

## Runtime Flow

1. the user pairs the extension to the local daemon
2. the CLI exposes WebSocket and stdio JSON-RPC
3. the agent issues first-class CLI commands or raw RPC calls
4. the CLI routes browser calls through the extension bridge
5. traces and snapshots are written under the configured bak data directory (default on Windows: `Join-Path $env:LOCALAPPDATA 'bak'`)

## Workspace And Targeting

- the workspace is the default agent isolation boundary
- browser commands prefer the current workspace tab once it exists
- workspace commands are the only path that creates or repairs the dedicated window and tab group
- reads, actions, and debug output share one context stack
