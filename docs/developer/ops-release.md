# Ops And Release

## Local Operations

Core checks:

```powershell
pnpm build
node packages/cli/dist/bin.js doctor
```

Useful runtime commands:

```powershell
node packages/cli/dist/bin.js pair
node packages/cli/dist/bin.js pair status
node packages/cli/dist/bin.js export --out ./.bak-data/diag.zip
node packages/cli/dist/bin.js gc
```

## Pre-Release Gates

```powershell
pnpm -w typecheck
pnpm -w lint
pnpm -w test:unit
pnpm -w test:e2e:critical
pnpm -w e2e:matrix
pnpm -w release:report
```

Full regression run:

```powershell
pnpm -w test:e2e:full
```

## Capability And E2E Artifacts

- Capability map: `docs/CAPABILITY_MATRIX.md`
- E2E matrix: `docs/E2E_MATRIX.md`
- Release gate summary: `docs/RELEASE_CAPABILITY_REPORT.md`

Important semantics:

- `CaseMapped=true` means case IDs are mapped, not that CI has executed/passed them.
- `ReleaseGate=fail` means real e2e execution requirements are not satisfied.

## Generated File Paths (Do Not Move)

These paths are consumed by scripts:

- `scripts/e2e/generate-matrix.ps1` -> `docs/E2E_MATRIX.md`
- `scripts/release/generate-capability-report.ps1` -> `docs/RELEASE_CAPABILITY_REPORT.md`

Keep those output paths stable.
