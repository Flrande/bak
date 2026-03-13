# Release Capability Report

- GeneratedAt: 2026-03-14 01:52:27 +08:00
- TotalCapabilities: 81
- StabilityBreakdown: stable=55 beta=26 experimental=0
- E2ECaseMapped: 81 / 81
- E2EExecutionStatus: passed=59 failed=0 notRun=22
- ReleaseScope: dynamic-data-v1
- ReleaseScopeCoverage: mapped=15 / 15 passed=15 failed=0 notRun=0 missing=0
- ReleaseScopeGate: pass
- FullCoverageGate: fail (method-level real e2e still incomplete)
- ReleaseGate: pass

## Sources

- `docs/CAPABILITY_MATRIX.md`
- `docs/E2E_MATRIX.md`
- `tests/e2e/methods/release-scope.json`

## Gate Summary

- New methods must have matrix mapping and method-level e2e case IDs.
- `ReleaseGate` blocks shipping and follows the tracked release scope in `tests/e2e/methods/release-scope.json`.
- `FullCoverageGate` is an informational visibility signal for method-level real e2e completion across the whole protocol surface.
- Run `pnpm -w test:e2e:critical`, then regenerate `docs/E2E_MATRIX.md`, before checking the release gate for a normal ship decision.
- Run `pnpm -w test:e2e:full`, then regenerate `docs/E2E_MATRIX.md`, when you want a refreshed whole-surface coverage snapshot.

