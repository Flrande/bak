# Memory Guide

The `v3` memory system is explicit and agent-centered.

## Durable Memory Kinds

- `route`: how to reach a page or feature
- `procedure`: how to perform a task on a page
- `composite`: an execution composition such as route + procedure

## Lifecycle

1. begin a capture session
2. collect capture events
3. end capture
4. inspect generated drafts
5. promote a draft to a durable memory
6. search for candidates later
7. explain applicability before planning
8. create a plan with explicit parameters
9. execute the plan in `dry-run`, `assist`, or `auto`
10. inspect runs and patch suggestions
11. accept or reject patches explicitly

## Important Rules

- memory is advisory, not automatic
- only one capture session can be active at a time
- search never executes anything
- search can use the current tab or an explicit `url` when no live tab context is available
- if you want repeated path reuse, capture and promote a `route` draft explicitly instead of relying on a `procedure` or `composite` to stand in for navigation
- the system does not silently create durable memories
- the system does not silently recall durable memories
- the system does not silently execute durable memories
- durable revisions are immutable
- applying a patch creates a new revision
- patch review is one-way: an open patch can be applied or rejected once
- old revisions remain inspectable
- default execution mode is `assist`
- captured text stays literal unless it is already templated or clearly sensitive, such as password-like fields
- captured element steps keep live locator candidates from the page element that was actually used, which gives later patch suggestions more signal than the original raw locator alone
- memory fingerprints use the active document URL/title for the current context, not always the top-level tab

## Execution Modes

- `dry-run`: assemble and report the plan without browser mutation
- `assist`: run conservative steps but pause before mutating procedure steps by default
- `auto`: execute the full plan

## Applicability

- route memories are checked against the current entry page
- procedure memories are checked against the page where the task should run
- composite route + procedure plans check the route entry page and the route-to-procedure handoff, so a procedure is not treated as inapplicable just because you are still on the route entry page
- direct `composite` memories use that same applicability model when planned by `memoryId`
- route matching is still heuristic: same-site but wrong-entry pages can surface as `partial` rather than `inapplicable`, so agents should review `entry-page` checks before executing

## Recommended Route Workflow

1. start a capture on the page where the route begins
2. drive the browser to the feature or page entry point, including explicit `page wait` steps when the path depends on navigation or async rendering
3. end capture and promote the `route` draft
4. later, search with `--kind route`
5. explain or plan the route against the current starting page before execution
6. optionally compose that route with a separate `procedure` memory once you arrive at the feature page

## Storage

- backend: sqlite only
- file: `.bak-data/memory.sqlite`

## Example

```powershell
bak memory capture begin --goal "return to the automation console" --rpc-ws-port 17374
bak element click --css '#goto-spa' --rpc-ws-port 17374
bak page wait --mode selector --value '#tab-automation' --rpc-ws-port 17374
bak element click --css '#tab-automation' --rpc-ws-port 17374
bak page wait --mode text --value 'Route: automation' --rpc-ws-port 17374
bak memory capture end --rpc-ws-port 17374
bak memory draft promote <routeDraftId> --rpc-ws-port 17374
bak memory search --goal "return to the automation console" --kind route --rpc-ws-port 17374
bak memory explain <routeMemoryId> --url "https://portal.local/" --rpc-ws-port 17374
bak memory plan create --memory-id <routeMemoryId> --mode assist --rpc-ws-port 17374
bak memory execute <planId> --rpc-ws-port 17374
```
