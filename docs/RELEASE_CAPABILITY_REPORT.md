# Release Capability Report

- GeneratedAt: 2026-03-13 15:59:21 +08:00
- TotalCapabilities: 81
- StabilityBreakdown: stable=55 beta=26 experimental=0
- E2ECaseMapped: 81 / 81
- E2EExecutionStatus: passed=59 failed=0 notRun=22
- CurrentScope: dynamic-data-v1
- CurrentScopeCoverage: mapped=15 / 15 passed=15 failed=0 notRun=0 missing=0
- CurrentScopeGate: pass
- ReleaseGate: fail (real e2e not complete)

## Sources

- `docs/CAPABILITY_MATRIX.md`
- `docs/E2E_MATRIX.md`
- `tests/e2e/methods/release-scope.json`

## Gate Summary

- New methods must have matrix mapping and method-level e2e case IDs.
- The current release scope passes only when every scoped method is mapped and has `CI Status=Passed` in the E2E matrix.
- Release requires regenerated capability/e2e matrices, this report, and all mapped e2e cases executed with `CI Status=Passed`.

