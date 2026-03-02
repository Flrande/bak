# RELEASE GUIDE (v2)

This legacy page is kept for compatibility. Prefer [docs/developer/ops-release.md](./developer/ops-release.md).

## Versioning policy

- SemVer for `@flrande/bak-*` packages.
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
pnpm -w test:e2e:critical
pnpm -w e2e:matrix
pnpm -w release:report
```

Nightly full gate:

```powershell
pnpm -w test:e2e:full
```

## Compatibility matrix (current)

- Node.js: 22.x
- OS baseline: Windows + PowerShell 7
- Browser: Chromium with MV3 extension support

## Upgrade checklist

1. Read `docs/PROTOCOL_V2.md` for method/result changes.
2. Run `bak doctor` after upgrade.
3. Keep existing pairing token or rotate with `bak pair`.
4. If enabling SQLite backend, run `bak memory migrate` and verify with `bak memory export --backend sqlite`.
5. Publish with synced artifacts:
   - `docs/CAPABILITY_MATRIX.md`
   - `docs/E2E_MATRIX.md`
   - `docs/RELEASE_CAPABILITY_REPORT.md`

