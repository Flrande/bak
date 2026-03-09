# Technical Spec

## Product Shape

Browser Agent Kit is a paired system:

- a Chromium extension running in the real browser
- a local CLI daemon exposing browser capabilities to an agent

Both are product surface, not internal implementation detail.

## Workspace Model

The workspace is the default agent isolation boundary:

- one default workspace id
- a dedicated browser window
- a dedicated tab group inside that window
- tracked workspace tab ids plus primary and current tab pointers

Default targeting resolves in this order:

1. explicit `tabId`
2. explicit `workspaceId`
3. current tab in an existing default workspace
4. browser active tab when no workspace exists yet

Ordinary browser commands do not create a workspace. Explicit workspace commands such as `workspace.ensure` and `workspace.openTab` do.

## Context Model

Supported effective contexts:

- top-level page
- nested frame
- nested shadow DOM
- frame + shadow combinations

Requirement:

- actions, reads, and debug APIs must resolve against the same effective context stack

## Memory Model

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

Memory kinds:

- `route`
- `procedure`
- `composite`

Rules:

- durable writes are explicit
- capture is single-active
- search never executes
- revisions are immutable
- accepted patches create new revisions
- the current backend is sqlite

## Debug Surface

Agent-usable debug output includes:

- visual snapshot
- element map
- extracted text
- accessibility nodes
- current-context URL and title
- console entries
- network entries
- viewport and metrics
- current frame and shadow context

`debug.dumpState` can optionally attach a fresh persisted viewport snapshot when `includeSnapshot` is requested.
