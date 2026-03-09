# CLI Guide

`bak` is the primary agent-facing interface to the paired browser extension.

## Runtime Commands

```text
bak setup
bak serve
bak doctor
bak export
bak gc
bak call
```

## Pairing Commands

```text
bak pair create
bak pair status
bak pair revoke
```

## First-Class Browser Commands

```text
bak tabs list|new|focus|get|close|active
bak workspace ensure|info|open-tab|list-tabs|get-active-tab|set-active-tab|focus|reset|close
bak page goto|wait|url|title|snapshot|text|dom|a11y|metrics|viewport
bak debug console|dump-state
bak network list|get|wait|clear
bak context enter-frame|exit-frame|enter-shadow|exit-shadow|reset
bak element get|click|type|hover|double-click|right-click|select|check|uncheck|scroll|scroll-into-view|focus|blur|drag-drop
bak keyboard press|type|hotkey
bak mouse move|click|wheel
bak file upload
```

## First-Class Memory Commands

```text
bak memory capture begin|mark|end
bak memory draft list|show|promote|discard
bak memory search
bak memory explain
bak memory show
bak memory deprecate
bak memory delete
bak memory plan create|show
bak memory execute
bak memory run list|show
bak memory patch list|show|apply|reject
bak memory export
```

Notes:
- `bak workspace ensure` creates or repairs the default agent workspace: a dedicated browser window plus a dedicated tab group
- `bak workspace open-tab` opens a tab inside that workspace and groups it automatically
- `bak workspace get-active-tab` shows the workspace current tab used by default browser and memory commands
- `bak workspace set-active-tab --tab-id <id>` switches that default workspace current tab without focusing the workspace window
- once the workspace exists, browser and memory commands prefer the workspace current tab unless you pass `--tab-id` or another explicit target
- ordinary omitted-target browser commands do not create a workspace; if no workspace exists they use the browser's active tab until you run `bak workspace ensure` or `bak workspace open-tab`
- `bak workspace focus` is the explicit command for bringing the workspace window to the front
- `bak page url` and `bak page title` report the active document for the current frame/shadow context; use `bak call --method session.info` for top-level tab metadata
- `bak page snapshot --include-base64` returns inline image bytes in addition to persisted snapshot paths
- `bak debug dump-state --include-snapshot` attaches a fresh persisted viewport snapshot to the structured dump, and `--include-snapshot-base64` adds inline image bytes when needed
- `bak debug console` is structured but best-effort for page-origin logs; use it as advisory agent context rather than as a guaranteed browser-devtools mirror
- `bak network list|get|wait|clear` is best-effort for page requests: when page-level interception cannot attach response metadata, entries fall back to `kind: "resource"` with `status: 0`
- `bak element drag-drop` requires explicit `--from-*` and `--to-*` locators
- `bak element scroll` and `bak mouse wheel` accept negative deltas
- `bak mouse move` and `bak mouse click` accept zero coordinates

## Daily Flow

```powershell
bak serve --port 17373 --rpc-ws-port 17374
bak doctor --port 17373 --rpc-ws-port 17374
bak workspace ensure --rpc-ws-port 17374
bak workspace open-tab --url "https://example.com" --rpc-ws-port 17374
bak workspace get-active-tab --rpc-ws-port 17374
bak page snapshot --include-base64 --rpc-ws-port 17374
bak debug dump-state --include-snapshot --rpc-ws-port 17374
```

## Route Memory Example

```powershell
bak memory capture begin --goal "return to the automation console" --rpc-ws-port 17374
bak element click --css '#goto-spa' --rpc-ws-port 17374
bak page wait --mode selector --value '#tab-automation' --rpc-ws-port 17374
bak element click --css '#tab-automation' --rpc-ws-port 17374
bak page wait --mode text --value 'Route: automation' --rpc-ws-port 17374
bak memory capture end --rpc-ws-port 17374
bak memory draft list --rpc-ws-port 17374
bak memory draft promote <routeDraftId> --rpc-ws-port 17374
bak memory search --goal "return to the automation console" --kind route --rpc-ws-port 17374
bak memory explain <routeMemoryId> --url "https://portal.local/" --rpc-ws-port 17374
bak memory plan create --memory-id <routeMemoryId> --mode assist --rpc-ws-port 17374
bak memory execute <planId> --rpc-ws-port 17374
```

## Procedure Composition Example

```powershell
bak memory capture begin --goal "queue nightly backup task" --rpc-ws-port 17374
bak memory capture mark --label "start automation task" --role procedure --rpc-ws-port 17374
bak element type --css '#task-input' --value 'Nightly backup task' --clear --rpc-ws-port 17374
bak element click --css '#queue-btn' --rpc-ws-port 17374
bak page wait --mode text --value 'queued Nightly backup task' --rpc-ws-port 17374
bak memory capture end --rpc-ws-port 17374
bak memory draft promote <procedureDraftId> --rpc-ws-port 17374
bak memory plan create --route-memory-id <routeMemoryId> --procedure-memory-id <procedureMemoryId> --mode auto --rpc-ws-port 17374
bak memory execute <planId> --rpc-ws-port 17374
```

All first-class commands print machine-friendly JSON.

Notes:
- capture is single-active, so start a new capture only after ending the current one
- `bak memory search` accepts `--url` when you want ranking against an explicit page context instead of the live tab
- `bak memory explain` also accepts `--url` when you want applicability against an explicit page context without relying on the live tab
- route memories are first-class: when the goal is “get back to the feature,” search with `--kind route` instead of relying on a procedure or composite to stand in for navigation
- direct `composite` memories planned by `--memory-id` use the same route-entry and handoff checks as `--route-memory-id` plus `--procedure-memory-id`
- captured text inputs stay literal unless they were already templated or clearly sensitive
- captured element steps keep live locator candidates from the element that was actually used, which gives later patch suggestions more signal than the original raw locator alone
