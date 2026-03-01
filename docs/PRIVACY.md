# PRIVACY (v1)

## Default collection behavior

1. Snapshot element maps do not read `input.value` for naming or text extraction.
2. Element `name`/`text` fields are minimized and passed through redaction rules.
3. Potential secrets (email-like strings, OTP-like digits, long numeric sequences, token-like query strings) are replaced with redacted markers.
4. Trace logs are redacted before write (for example `element.type.text` is stored as `[REDACTED]`, and snapshot base64 payloads are not persisted in trace entries).
5. Snapshot images and traces stay local in `.bak-data` unless the user exports them.

Run `bak gc` to clean old traces/snapshots. The command is dry-run by default and requires `--force` to delete.

## Debug rich-text mode

- The extension popup exposes `Allow richer text capture for debugging`.
- Default is `OFF`.
- When enabled, collection keeps the same redaction rules but allows longer text snippets to help diagnose locator issues.

Use this mode only for short debugging sessions and disable it afterward.

## Non-goals

- No cookie/password/session-secret exfiltration.
- No cloud upload channel.
- No hidden sensitive capture path; richer collection requires explicit local opt-in.
