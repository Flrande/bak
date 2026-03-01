# SECURITY (v1)

## Security controls implemented

1. Localhost-only extension bridge
- extension websocket target is hardcoded to `ws://127.0.0.1:<port>`

2. Pairing token
- daemon verifies token during websocket upgrade
- extension stores token in `chrome.storage.local`
- unauthenticated extensions are rejected
- token metadata includes `createdAt` + `expiresAt`
- CLI supports rotate (`bak pair`), revoke (`bak pair revoke`) and status (`bak pair status`)

3. High-risk action gate
- keyword-based high-risk detection in content script (`submit/delete/send/upload` + CN variants)
- click/type high-risk targets require overlay confirmation
- rejection returns permission error

4. Minimal sensitive-data handling
- no cookie export API
- no password/captcha bypass feature
- recording text is masked for likely password/otp fields
- element map naming no longer reads `input.value`
- snapshot text fields use rule-based redaction before leaving content script
- CLI re-applies redaction before writing `elements.json` (defense-in-depth)

5. Explicit debug gate
- popup exposes `debugRichText` toggle for richer diagnostics
- default is disabled
- even when enabled, redaction still applies

6. Debug scope limitation
- debug v1 only returns buffered page error events (and optional console scope)
- no full network interception in v1

7. Policy engine + audit (MVP)
- CLI loads local policy file `.bak-data/.bak-policy.json` (override with `BAK_POLICY_PATH`)
- decisions: `allow | deny | requireConfirm`
- default conservative behavior:
  - file upload actions denied
  - destructive/payment/submit-like actions require confirmation
- every decision is appended to trace as `policy.decision` (locator summary only, no raw sensitive text)

8. Extension least-privilege hardening
- extension keeps `<all_urls>` host permission for `captureVisibleTab` compatibility
- content scripts are still limited to `http://*/*` and `https://*/*` only
- unsupported tabs (`chrome://`, `chrome-extension://`, `file://`) are blocked by runtime URL policy and return `E_PERMISSION`

## Known limitations / risks (v1)

- Keyword risk detector can have false positives/false negatives.
- Pair token stored locally in plain text under `.bak-data/pairing.json`.
- Extension popup currently does not provide rotate/revoke buttons; use CLI commands.
- Memory backend (`memory.json` or `memory.sqlite`) is local-only but not encrypted at rest.
- Healing candidate ranking is heuristic and can select wrong elements on dense UIs.
- Rich text debug mode can still capture non-secret page copy; enable only when needed.

## Mitigations and operational guidance

- Keep daemon bound to localhost only (default behavior).
- Rotate token regularly (`bak pair`) and re-pair extension.
- Keep `.bak-data` out of source control.
- Run `bak gc` regularly to enforce local retention and reduce stale artifacts.
- Use policy file for domain/path/action guardrails:

```json
{
  "rules": [
    {
      "id": "allow-upload-internal-admin",
      "action": "element.click",
      "domain": "admin.example.com",
      "pathPrefix": "/files",
      "tag": "fileUpload",
      "decision": "allow",
      "reason": "internal reviewed flow"
    }
  ]
}
```

- Require human supervision for destructive operations.
- Keep rich-text debug capture disabled unless investigating locator failures.
- For production-hardening, replace file memory with encrypted store and add stronger auth.

## Explicit non-goals

- No login bypass or anti-bot bypass
- No exfiltration of cookies/password managers/session secrets
- No remote cloud control channel in v1
