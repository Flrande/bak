# Protocol v3

`bak` uses JSON-RPC 2.0 over stdio or WebSocket.

This document describes the active protocol baseline: `v3`.

Schema artifact:
- `packages/protocol/schemas/protocol.schema.json`

## Envelope

Request:

```json
{
  "jsonrpc": "2.0",
  "id": "string|number|null",
  "method": "method.name",
  "params": {}
}
```

Success:

```json
{
  "jsonrpc": "2.0",
  "id": "same-as-request",
  "result": {}
}
```

Failure:

```json
{
  "jsonrpc": "2.0",
  "id": "same-as-request",
  "error": {
    "code": 4001,
    "message": "Not paired",
    "data": {
      "bakCode": "E_NOT_PAIRED"
    }
  }
}
```

## Error Codes

- `E_NOT_PAIRED`
- `E_PERMISSION`
- `E_NOT_FOUND`
- `E_NEED_USER_CONFIRM`
- `E_TIMEOUT`
- `E_INVALID_PARAMS`
- `E_INTERNAL`
- `E_NOT_READY`

## Session And Runtime

Key methods:
- `session.create`
- `session.close`
- `session.info`

`session.info` reports:
- protocol version and compatible versions
- bridge connection and heartbeat state
- active tab summary
- effective context stack
- active capture session id
- sqlite memory backend status

## Browser Surface

Primary method groups:
- `tabs.*`
- `workspace.*`
- `page.*`
- `element.*`
- `keyboard.*`
- `mouse.*`
- `file.upload`
- `context.*`
- `network.*`
- `debug.*`

Important behavior:
- default browser and memory targeting resolves in this order: explicit `tabId`, explicit `workspaceId`, current tab in an existing default workspace, browser active tab if no workspace exists
- the workspace is a dedicated browser window plus a dedicated tab group inside that window
- actions and reads share the same effective frame/shadow context
- `page.url`, `page.title`, DOM summaries, debug state, and memory fingerprints use the active document for the current context
- in frame context that document can differ from the top-level tab; use `session.info.activeTab` when you need top-level tab metadata
- `debug.dumpState` includes context, text, DOM summary, element map, metrics, viewport, console, and network
- `debug.dumpState` can optionally attach a fresh persisted snapshot artifact when `includeSnapshot` is requested
- `page.snapshot` returns image and element-map artifacts for agent inspection
- `debug.console` and `debug.dumpState.console` are best-effort for page-origin logs and should be treated as advisory, not a full browser-devtools stream
- `network.*` prefers page-level fetch/XHR capture, but can fall back to `resource` timing entries with `status: 0` when richer interception is unavailable

Workspace methods:
- `workspace.ensure`
- `workspace.info`
- `workspace.openTab`
- `workspace.listTabs`
- `workspace.getActiveTab`
- `workspace.setActiveTab`
- `workspace.focus`
- `workspace.reset`
- `workspace.close`

Workspace semantics:
- `workspace.ensure` creates or repairs the dedicated window, tab group, primary tab, and tracked tab set
- `workspace.openTab` opens a tab in the workspace window and adds it to the workspace tab group
- `workspace.getActiveTab` and `workspace.setActiveTab` manage the workspace current tab that default commands will use
- `workspace.focus` is the explicit command that brings the workspace window to the front
- default operations should not rely on "whatever tab is currently active" once the workspace exists
- ordinary omitted-target commands do not create the workspace; explicit workspace methods do

## Memory Surface

Capture:
- `memory.capture.begin`
- `memory.capture.mark`
- `memory.capture.end`

Drafts:
- `memory.drafts.list`
- `memory.drafts.get`
- `memory.drafts.promote`
- `memory.drafts.discard`

Durable memories:
- `memory.memories.search`
- `memory.memories.get`
- `memory.memories.explain`
- `memory.memories.deprecate`
- `memory.memories.delete`

Plans and execution:
- `memory.plans.create`
- `memory.plans.get`
- `memory.plans.execute`

Runs and patches:
- `memory.runs.list`
- `memory.runs.get`
- `memory.patches.list`
- `memory.patches.get`
- `memory.patches.apply`
- `memory.patches.reject`

## Memory Semantics

- capture is single-active: `memory.capture.begin` rejects while another capture is still open
- `memory.capture.mark` and `memory.capture.end` operate on the current active capture session
- search returns candidates only
- search can rank against the live tab context or an explicit `url`
- route search is entry-page oriented, procedure search is target-page oriented, and composite search/planning weighs both route entry fit and route-to-procedure handoff
- explain returns structured applicability and rationale
- plan creation binds parameters, checks current-page fit, and for route+procedure composition validates the route-to-procedure handoff instead of requiring the procedure to fit the entry page
- direct `composite` memories use the same route-entry plus route-to-procedure handoff applicability model as separately supplied route and procedure memories
- the recommended repeated-path workflow is: capture and promote a `route`, later search with `kind=route`, explain/plan it against the current starting page, then optionally compose it with a separate `procedure`
- execute always targets a specific plan
- drift produces explicit patch suggestions
- captured element steps keep live locator candidates from the current page element so drift repair can match by role/name/text/css instead of only the original locator
- durable memories are immutable by revision
- applying a patch creates a new revision
- patch review is one-way: `open -> applied` or `open -> rejected`
- default execution mode is `assist`
- captured text stays literal unless it is already templated or clearly sensitive, such as password-like fields

## CLI Notes

- `bak element drag-drop` requires explicit source and target locators via `--from-*` and `--to-*`
- `bak element scroll` and `bak mouse wheel` accept negative deltas
- `bak mouse move` and `bak mouse click` accept zero coordinates
- `bak page snapshot` accepts `--include-base64`
- `bak debug dump-state` accepts `--include-snapshot` and `--include-snapshot-base64`
- `bak memory explain` accepts `--url` when applicability should be evaluated against an explicit page context without relying on the live tab
- `bak workspace ensure|info|open-tab|list-tabs|get-active-tab|set-active-tab|focus|reset|close` expose the workspace lifecycle directly in the CLI
