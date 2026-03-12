# Setup Reference

Use this page only when the agent must help a human recover or finish runtime setup.

## Canonical Human Setup Path

Send the human to:

- [../../../docs/user/quickstart.md](../../../docs/user/quickstart.md)

Or, when a raw URL is required:

```text
https://raw.githubusercontent.com/Flrande/bak/refs/heads/master/docs/user/quickstart.md
```

Do not restate the full install flow in agent output unless the user explicitly asks for it. The quickstart page is the only source of truth for package install, unpacked-extension load, upgrade, and the normal runtime lifecycle.

## Agent-Specific Recovery Notes

- Always re-check with `bak doctor --port 17373 --rpc-ws-port 17374`.
- `bak doctor` auto-starts the local runtime when needed unless the human is intentionally running `bak serve` for debugging.
- Use `bak status --port 17373 --rpc-ws-port 17374` to inspect whether the runtime is already up, and `bak stop --port 17373 --rpc-ws-port 17374` when you need a clean restart.
- Do not ask the human to keep `bak serve` running as part of normal setup.
- If `bak doctor` shows `versionCompatibility`, assume the browser may still be running an older unpacked extension build.
- In that case, ask the human to reload `Browser Agent Kit` from `edge://extensions` or `chrome://extensions`, or restart the browser.
- Wait for confirmation before continuing.
- The runtime is fully aligned only when `bak doctor` shows `extensionConnected: true` and no `versionCompatibility` warning in `summary.warningChecks`.
