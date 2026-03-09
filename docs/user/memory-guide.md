# Memory Guide

`bak` memory is explicit and agent-centered.

## Memory Kinds

- `route`: how to get back to a page or feature
- `procedure`: how to do a task on a page
- `composite`: an execution composition, usually route + procedure

## Core Rules

- capture is explicit
- draft review is explicit
- promotion is explicit
- search never executes anything
- explain and plan happen before execution
- patches are explicit review items
- revisions are immutable
- the current backend is sqlite
- the default execution mode is `assist`

## Recommended Route Workflow

1. Start capture where the route begins.
2. Drive the browser to the feature or page entry point.
3. End the capture and inspect drafts.
4. Promote the route draft.
5. Later, search with `--kind route`.
6. Explain or plan the route against the current starting page.
7. Optionally compose that route with a separate procedure memory.

## Route Example

```powershell
bak memory capture begin --goal "return to billing settings" --rpc-ws-port 17374
bak element click --css '#open-settings' --rpc-ws-port 17374
bak page wait --mode text --value 'Billing' --rpc-ws-port 17374
bak memory capture end --rpc-ws-port 17374
bak memory draft list --rpc-ws-port 17374
bak memory draft promote <routeDraftId> --rpc-ws-port 17374
bak memory search --goal "return to billing settings" --kind route --rpc-ws-port 17374
bak memory explain <routeMemoryId> --url "https://portal.local/" --rpc-ws-port 17374
bak memory plan create --memory-id <routeMemoryId> --mode assist --rpc-ws-port 17374
bak memory execute <planId> --rpc-ws-port 17374
```

## Procedure Example

```powershell
bak memory capture begin --goal "queue nightly backup task" --rpc-ws-port 17374
bak memory capture mark --label "task input ready" --role procedure --rpc-ws-port 17374
bak element type --css '#task-input' --value 'Nightly backup task' --clear --rpc-ws-port 17374
bak element click --css '#queue-btn' --rpc-ws-port 17374
bak page wait --mode text --value 'queued Nightly backup task' --rpc-ws-port 17374
bak memory capture end --rpc-ws-port 17374
bak memory draft promote <procedureDraftId> --rpc-ws-port 17374
```

## Planning And Execution

Use `--memory-id` for a single durable memory:

```powershell
bak memory plan create --memory-id <memoryId> --mode assist --rpc-ws-port 17374
```

Use route + procedure when you want explicit composition:

```powershell
bak memory plan create --route-memory-id <routeMemoryId> --procedure-memory-id <procedureMemoryId> --rpc-ws-port 17374
```

Execution modes:

- `dry-run`: assemble and report the plan without browser mutation
- `assist`: run conservatively and pause before risky procedure steps
- `auto`: execute the full plan

## Storage

- data directory: `.bak-data`
- memory database: `.bak-data/memory.sqlite`
