# RELEASE GUIDE (v1)

## Versioning policy

- SemVer for `@bak/*` packages.
- Protocol compatibility rule:
  - additive fields/methods: minor
  - incompatible request/response changes: major
  - bug fix only: patch

## Pre-release quality gates

Run before tagging:

```powershell
pnpm -w typecheck
pnpm -w lint
pnpm -w test:unit
pnpm -w test:e2e
```

## Compatibility matrix (current)

- Node.js: 22.x
- OS baseline: Windows + PowerShell 7
- Browser: Chromium with MV3 extension support

## Upgrade checklist

1. Read `docs/PROTOCOL.md` for method/result changes.
2. Run `bak doctor` after upgrade.
3. Keep existing pairing token or rotate with `bak pair`.
4. If enabling SQLite backend, run `bak memory migrate` and verify with `bak memory export --backend sqlite`.
