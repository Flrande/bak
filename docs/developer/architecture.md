# Architecture

## Major Components

- Extension: content script, background worker, popup pairing UI, overlay confirmation flow
- CLI: daemon, RPC server, browser driver abstraction, policy checks, diagnostics, local artifact persistence
- Protocol: shared request/response types and schema
- Test app: browser fixtures that exercise session, tabs, context, and debug flows

## Runtime Flow

1. the user pairs the extension to the local daemon
2. the CLI exposes WebSocket and stdio JSON-RPC
3. the agent issues first-class CLI commands or raw RPC calls
4. the CLI routes browser calls through the extension bridge
5. traces and snapshots are written under the configured bak data directory (default on Windows: `Join-Path $env:LOCALAPPDATA 'bak'`)

## Session And Targeting

- the session is the default agent isolation boundary
- browser commands prefer the current session tab once it exists
- session commands are the only public path that creates or repairs the dedicated window and tab group
- reads, actions, and debug output share one context stack

## Public Command Surface

- there is no public `workspace` namespace; user-facing terminology is `session` plus `tabs`
- `session` owns the dedicated browser binding, default active tab, and shared context stack
- `tabs` is the browser-wide direct-control surface for listing, opening, focusing, inspecting, and closing tabs outside the session helpers
- `page`, `context`, `element`, `debug`, `network`, `keyboard`, `mouse`, and `file` operate on the current session tab unless `--tab-id` overrides that target
- planned first-class commands should extend these existing noun groups instead of introducing parallel naming
