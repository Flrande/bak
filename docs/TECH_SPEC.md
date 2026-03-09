# Technical Spec

## Product Shape

Browser Agent Kit is a paired system:
- a Chromium MV3 extension that runs in the real user browser
- a local CLI daemon that exposes browser capabilities to an agent

The extension and CLI are both product surface, not implementation detail.

## Workspace Model

Browser automation defaults to a first-class agent workspace:
- one default workspace id
- a dedicated browser window as the main isolation boundary
- a dedicated tab group inside that window for agent-owned tabs
- tracked workspace tab ids plus primary/current tab pointers

Canonical runtime state:
- `workspaceId`
- `windowId`
- `groupId`
- `tabIds`
- `activeTabId`
- `primaryTabId`

Rules:
- default browser targeting resolves in this order: explicit `tabId`, explicit `workspaceId`, current tab in an existing default workspace, browser active tab only if no workspace exists
- `workspace.ensure` is the repair entrypoint for missing window, group, primary tab, and tracked tabs
- ordinary omitted-target commands do not create a workspace as a side effect; explicit workspace commands such as `workspace.ensure` and `workspace.openTab` do
- workspace repair must recover grouped/tracked tabs without adopting unrelated tabs in the same window
- explicit focus is separate from default targeting; workspace creation and default operations should avoid navigating the human user's active tab
- route-memory replay, explain, plan, and execute use workspace targeting when no explicit tab is provided

## Design Goals

- expose broad browser control and reading through first-class CLI commands and JSON-RPC
- keep browser action, browser reading, and browser debugging aligned to the same context model
- support reusable browser path memory without silent automation
- keep memory explainable, revision-safe, and conservative by default

## Memory Architecture

Core entities:
- `CaptureSession`
- `CaptureEvent`
- `DraftMemory`
- `DurableMemory`
- `MemoryRevision`
- `PageFingerprint`
- `MemoryPlan`
- `MemoryRun`
- `PatchSuggestion`

Kinds:
- `route`
- `procedure`
- `composite`

Rules:
- durable memory writes are explicit
- capture is single-active; agents must end the active capture before starting another
- search never executes
- search may rank against a live tab fingerprint or an explicit URL-only page context
- route ranking is entry-page oriented, procedure ranking is target-page oriented, and composite ranking considers both route entry fit and route-to-procedure handoff
- replay never mutates durable memory silently
- healing creates patch suggestions, not writeback
- patch review is one-way: open patches can resolve to applied or rejected, but not both
- runs are attached to specific revisions
- accepted patches create new revisions
- captured text inputs stay literal by default; only clearly sensitive inputs and file payloads are auto-parameterized
- composite route+procedure planning evaluates route entry fit plus route-to-procedure target handoff
- the recommended repeated-path workflow is: capture and promote a `route`, later search with `kind=route`, explain or plan it against the current starting page, then optionally compose it with a separate `procedure`
- captured element steps store live locator candidates from the element that was actually used so later drift repair can rank replacements by role/name/text/css instead of only the original raw locator

## Storage

- backend: sqlite only
- durable store location: `.bak-data/memory.sqlite`

## Context Model

Supported effective contexts:
- top-level page
- nested frame
- nested shadow DOM
- frame + shadow combinations

Requirement:
- actions, reads, and debug APIs must resolve against the same effective context stack
- context-aware metadata uses the active document for that stack; frame context may therefore report a different URL/title than the top-level tab

## Debug Surface

Agent-usable debug outputs include:
- visual snapshot
- element map
- extracted text
- accessibility nodes
- active-document URL/title for the current context
- console entries
- network entries
- viewport and metrics
- current frame/shadow context
- `debug.dumpState` can optionally attach a fresh persisted viewport snapshot artifact when the CLI requests `includeSnapshot`
- console capture is structured but best-effort for page-origin logs; it is not a full browser-devtools mirror
- network capture is best-effort: page-level fetch/XHR hooks are preferred, but the fallback path can degrade to `resource` timing entries with `status: 0`
