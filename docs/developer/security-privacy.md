# Security And Privacy

## Security Defaults

- the extension bridge is localhost-only
- a pairing token is required for extension connection
- high-risk actions can require explicit user confirmation
- unsupported browser-internal URLs are blocked by runtime policy
- the policy engine can allow, deny, or require confirmation by domain, path, and action

Policy file:

- default path on Windows: `Join-Path (Join-Path $env:LOCALAPPDATA 'bak') '.bak-policy.json'`
- override: `BAK_POLICY_PATH`

## Privacy Defaults

- snapshot extraction avoids raw `input.value` collection for element naming
- traces and snapshot metadata are redacted before persistence
- `bak export` excludes raw snapshot image folders unless `--include-snapshots`
- typed input is redacted in traces by default

## Operational Guidance

- keep the bak data directory out of source control when you override it into a repository
- rotate pairing tokens when reconnecting a browser profile
- use short retention windows and run `bak gc`
- enable richer debug capture only for active troubleshooting sessions
- export raw snapshots only when they are actually needed for diagnosis
