# PROTOCOL (JSON-RPC v1)

Schema artifact:
- `packages/protocol/schemas/protocol.schema.json`
- this file is versioned as `v1` and updated with additive compatibility by default

Base envelope:

```json
{
  "jsonrpc": "2.0",
  "id": "string|number|null",
  "method": "method.name",
  "params": {}
}
```

Response success:

```json
{
  "jsonrpc": "2.0",
  "id": "same-as-request",
  "result": {}
}
```

Response failure:

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

## Error codes

- `E_NOT_PAIRED`
- `E_PERMISSION`
- `E_NOT_FOUND`
- `E_NEED_USER_CONFIRM`
- `E_TIMEOUT`
- `E_INVALID_PARAMS`
- `E_INTERNAL`
- `E_NOT_READY`

## Methods

### Session

- `session.create`
- `session.close`
- `session.info`

`session.info` includes:
- `sessionId`
- `paired`
- `extensionConnected`
- `connectionState` (`connecting|connected|disconnected`)
- `connectionReason`
- `extensionVersion`
- `activeTab` (`null` or `{ id, title, url }`)
- `recording`
- `heartbeatStale`
- `heartbeatAgeMs`
- `staleAfterMs`
- `lastSeenTs`
- `lastHeartbeatTs`
- `bridgePendingRequests`
- `bridgeLastError`
- `bridgeTotalRequests`
- `bridgeTotalFailures`
- `bridgeTotalTimeouts`
- `bridgeTotalNotReady`

When heartbeat age exceeds `staleAfterMs`, service reports `connectionState=disconnected` with `connectionReason=heartbeat-timeout`.

### Tabs

- `tabs.list`
- `tabs.focus`
- `tabs.new`
- `tabs.close`

### Page

- `page.goto`
- `page.back`
- `page.forward`
- `page.reload`
- `page.wait` (selector/text/url)
- `page.snapshot`

### Elements

- `element.click`
- `element.type`
- `element.scroll`

Action behavior notes:
- `element.click` scrolls target into view, checks center-point obstruction, then dispatches pointer/mouse click sequence.
- `element.type` uses native input/textarea value setter + `input/change` events.
- Covered/disabled targets return structured permission failures instead of silent no-op.
- `element.click` / `element.type` accept optional `requiresConfirm` to force explicit user confirmation.

### Debug

- `debug.getConsole`

### Memory

- `memory.recordStart`
- `memory.recordStop`
- `memory.skills.list`
- `memory.skills.show`
- `memory.skills.retrieve`
- `memory.skills.run`
- `memory.skills.delete`

## `page.snapshot` result

- `traceId`
- `imagePath`
- `elementsPath`
- `imageBase64` (optional)
- `elementCount`

## Trace audit events

Traces are written to `.bak-data/traces/<traceId>.jsonl` as method/result/error events.

`policy.decision` audit event includes:
- `action`
- `decision`
- `reason`
- `source`
- `ruleId`
- `domain`
- `path`
- `locatorSummary` (`hasEid/hasRole/hasName/hasText/hasCss`)
- `tags`
- `matchedRuleCount`
- `matchedRules` (summary only: `id/action/decision/tag`)
- `defaultDecision`
- `defaultReason`

Policy audit fields intentionally exclude raw sensitive text payloads.

## Locator schema

Any of:
- `eid`
- `role` + `name`
- `text`
- `css`

CLI/skill healing tries candidates in this order.

## Known limits (v1)

- Nested cross-origin iframe content is not targeted in v1.
- Shadow DOM locator coverage is best-effort and may miss closed-shadow targets.
- When locator css explicitly targets unsupported iframe/shadow patterns, API returns `E_NOT_FOUND` with a limitation hint.
- Browser-internal URLs (`chrome://`, `chrome-extension://`, `file://`) are intentionally blocked and return `E_PERMISSION`.
