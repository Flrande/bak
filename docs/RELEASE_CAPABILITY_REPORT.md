# Release Capability Report

- GeneratedAt: 2026-03-11 15:08:27 +08:00
- TotalCapabilities: 66
- StabilityBreakdown: stable=55 beta=11 experimental=0
- E2ECaseMapped: 55 / 66
- E2EExecutionStatus: passed=0 failed=11 notRun=55
- ReleaseGate: fail (real e2e not complete)

## Sources

- `docs/CAPABILITY_MATRIX.md`
- `docs/E2E_MATRIX.md`

## Gate Summary

- New methods must have matrix mapping and method-level e2e case IDs.
- Release requires regenerated capability/e2e matrices, this report, and all mapped e2e cases executed with `CI Status=Passed`.

