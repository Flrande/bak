# Security And Privacy

## Security Defaults

- Extension bridge is localhost-only.
- Pair token is required for extension connection.
- High-risk actions can require explicit user confirmation.
- Policy engine can allow/deny/requireConfirm per domain/path/action.
- Unsupported browser-internal URLs are blocked by runtime policy.

Policy file:

- default path: `.bak-data/.bak-policy.json`
- override: `BAK_POLICY_PATH`

## Privacy Defaults

- Snapshot extraction avoids raw `input.value` collection for element naming.
- Traces and snapshot metadata are redacted before persistence.
- `bak export` excludes raw snapshot image folders unless `--include-snapshots`.
- Memory recording redacts typed input by default.

## Operational Guidance

- Keep `.bak-data` out of source control.
- Rotate pairing token regularly (`bak pair`).
- Use short retention windows and run `bak gc`.
- Enable richer debug capture only for explicit troubleshooting windows.

## Detailed References

- [docs/SECURITY.md](../SECURITY.md)
- [docs/PRIVACY.md](../PRIVACY.md)
