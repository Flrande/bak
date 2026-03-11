# Technical Spec

## Product Shape

Browser Agent Kit is a paired system:

- a Chromium extension running in the real browser
- a local CLI daemon exposing browser capabilities to an agent

Both are product surface, not internal implementation detail.

## Session Model

The session is the default agent isolation boundary:

- one explicit session id per agent
- a dedicated browser window
- a dedicated tab group inside that window
- tracked session tab ids plus primary and current tab pointers
- an internal session binding id used to manage the browser resources

Default targeting resolves in this order:

1. explicit `tabId`
2. explicit `sessionId`
3. current tab in an existing session binding
4. browser active tab when no session binding exists yet

Ordinary browser commands do not create a session binding. Explicit session commands such as `session.ensure` and `session.openTab` do.

## Context Model

Supported effective contexts:

- top-level page
- nested frame
- nested shadow DOM
- frame + shadow combinations

Requirement:

- actions, reads, and debug APIs must resolve against the same effective context stack

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
