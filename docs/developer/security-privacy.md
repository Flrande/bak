# Security And Privacy

## Security Defaults

- the extension bridge is localhost-only
- a pairing token is required for extension connection
- high-risk actions can require explicit user confirmation
- unsupported browser-internal URLs are blocked by runtime policy
- the policy engine can allow, deny, or require confirmation by domain, path, and action

Policy file:

- default path: `.bak-data/.bak-policy.json`
- override: `BAK_POLICY_PATH`

## Privacy Defaults

- snapshot extraction avoids raw `input.value` collection for element naming
- traces and snapshot metadata are redacted before persistence
- `bak export` excludes raw snapshot image folders unless `--include-snapshots`
- memory capture is explicit and durable memories are created only after draft promotion
- typed input is redacted in traces by default

## Operational Guidance

- keep `.bak-data` out of source control
- rotate pairing tokens when reconnecting a browser profile
- use short retention windows and run `bak gc`
- enable richer debug capture only for active troubleshooting sessions
- export raw snapshots only when they are actually needed for diagnosis
