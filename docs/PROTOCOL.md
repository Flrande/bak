# Protocol

`bak` uses JSON-RPC 2.0 over stdio or WebSocket.

Current runtime constant:

- `PROTOCOL_VERSION` in `@flrande/bak-protocol`

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

## Core Method Families

- `session.*`
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

## Runtime Semantics

- default targeting resolves in this order: explicit `tabId`, explicit `workspaceId`, current tab in an existing workspace, browser active tab if no workspace exists
- the workspace is a dedicated browser window plus a dedicated tab group
- actions, reads, and debug output share the same effective frame and shadow context
- `page.url`, `page.title`, DOM summaries, and debug state use the active document for the current context
- `session.info.activeTab` is the top-level tab summary when you need tab metadata instead of the current frame document

## CLI Mapping

The CLI covers the high-frequency workflows directly. Use `bak call` for protocol methods that exist in the schema but do not have a dedicated CLI command.

Examples:

```powershell
bak call --method page.reload --params "{}" --rpc-ws-port 17374
bak call --method page.back --params "{}" --rpc-ws-port 17374
bak call --method page.scrollTo --params '{"x":0,"y":640}' --rpc-ws-port 17374
```
