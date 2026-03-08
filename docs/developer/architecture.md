# Architecture

## Major Components

- Extension: content script, background worker, popup pairing UI, overlay interactions
- CLI: daemon, RPC server, browser driver abstraction, policy checks, diagnostics, memory service
- Protocol: shared `v3` request/response types and schema
- Test app: multi-page browser fixtures for e2e context, debug, and memory coverage

## Runtime Flow

1. user pairs extension to the local CLI daemon
2. CLI exposes WebSocket and stdio JSON-RPC
3. agent issues first-class CLI commands or raw RPC calls
4. CLI routes browser calls through the extension bridge
5. traces, snapshots, and sqlite memory records are written under `.bak-data`

## Memory Subsystem

The memory subsystem no longer centers on skills.

Instead it uses:
- explicit capture sessions
- draft generation for review
- durable memories with immutable revisions
- memory search plus explain before planning
- plan execution with explicit mode
- explicit patch suggestion review for drift

## Execution Safety

- policy checks still gate high-risk actions
- `assist` is the default plan execution mode
- mutating procedure steps pause in assist mode
- patch application is explicit and revisioned

## Context Alignment

The extension maintains a shared effective context stack for:
- action APIs
- read APIs
- debug APIs

This prevents the agent from acting inside one frame or shadow root while reading from another.
