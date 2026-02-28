# SECURITY (v1)

## Security controls implemented

1. Localhost-only extension bridge
- extension websocket target is hardcoded to `ws://127.0.0.1:<port>`

2. Pairing token
- daemon verifies token during websocket upgrade
- extension stores token in `chrome.storage.local`
- unauthenticated extensions are rejected

3. High-risk action gate
- keyword-based high-risk detection in content script (`submit/delete/send/upload` + CN variants)
- click/type high-risk targets require overlay confirmation
- rejection returns permission error

4. Minimal sensitive-data handling
- no cookie export API
- no password/captcha bypass feature
- recording text is masked for likely password/otp fields

5. Debug scope limitation
- debug v1 only returns buffered page error events (and optional console scope)
- no full network interception in v1

## Known limitations / risks (v1)

- Keyword risk detector can have false positives/false negatives.
- Pair token stored locally in plain text under `.bak-data/pairing.json`.
- Extension popup currently does not provide token rotation UI; rotate by re-running `bak pair`.
- `memory.json` is file-based and not encrypted.
- Healing candidate ranking is heuristic and can select wrong elements on dense UIs.

## Mitigations and operational guidance

- Keep daemon bound to localhost only (default behavior).
- Rotate token regularly (`bak pair`) and re-pair extension.
- Keep `.bak-data` out of source control.
- Require human supervision for destructive operations.
- For production-hardening, replace file memory with encrypted store and add stronger auth.

## Explicit non-goals

- No login bypass or anti-bot bypass
- No exfiltration of cookies/password managers/session secrets
- No remote cloud control channel in v1
