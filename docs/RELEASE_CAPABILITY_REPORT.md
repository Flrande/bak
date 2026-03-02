# Release Capability Report

- GeneratedAt: 2026-03-03 00:23:12 +08:00
- TotalCapabilities: 66
- StabilityBreakdown: stable=45 beta=18 experimental=2
- E2ECaseMapped: 65 / 66
- E2EExecutionStatus: passed=0 failed=1 notRun=65
- ReleaseGate: fail (real e2e not complete)

## Sources

- `docs/CAPABILITY_MATRIX.md`
- `docs/E2E_MATRIX.md`

## Gate Summary

- New methods must have matrix mapping and method-level e2e case IDs.
- Release requires regenerated capability/e2e matrices, this report, and all mapped e2e cases executed with `CI Status=Passed`.

