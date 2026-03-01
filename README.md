# Browser Agent Kit (bak)

Browser Agent Kit is a TypeScript monorepo that lets a coding agent control a **real user browser** through a Chrome/Edge MV3 extension.

It includes:
- `packages/extension`: MV3 extension (background worker + content script + overlay UI + popup pairing)
- `packages/cli`: `bak` CLI daemon with JSON-RPC (stdio + ws) and extension bridge
- `packages/protocol`: shared TS protocol types/schemas/errors
- `apps/test-sites`: local test app for automation scenarios
- `tests`: unit + e2e tests

## Runtime

- Node.js: **22.x LTS**
- Package manager: `pnpm`
- OS assumption: Windows + PowerShell 7

## Repo layout

```text
repo/
  package.json
  pnpm-workspace.yaml
  packages/
    protocol/
    cli/
    extension/
  apps/
    test-sites/
  tests/
    unit/
    e2e/
  docs/
    TECH_SPEC.md
    PROTOCOL.md
    SECURITY.md
    PRIVACY.md
    OPS_RUNBOOK.md
    RELEASE.md
  scripts/
    demo-rpc.ps1
```

## Install

```powershell
pnpm i
```

## Build / Dev / Test

```powershell
pnpm build
pnpm dev
pnpm test
```

CI strategy:
- PR/push: typecheck + lint + unit tests (`.github/workflows/ci.yml`)
- e2e: nightly/manual workflow (`.github/workflows/e2e-nightly.yml`)

`pnpm dev` starts:
- protocol watcher
- cli daemon on `17373` (+ rpc ws `17374`)
- extension build watcher (`packages/extension/dist`)
- test-site dev server on `http://127.0.0.1:4173`

## Run `bak` commands

Use either form:

```powershell
# local workspace way
pnpm --filter @bak/cli exec bak serve --port 17373

# if you globally linked @bak/cli, this is equivalent
bak serve --port 17373
```

## Pairing + launch demo (manual)

1) Start test site:

```powershell
pnpm --filter @bak/test-sites dev
```

2) Generate pair token:

```powershell
pnpm --filter @bak/cli exec bak pair
pnpm --filter @bak/cli exec bak pair status
# revoke current token if needed
pnpm --filter @bak/cli exec bak pair revoke
```

3) Start daemon:

```powershell
pnpm --filter @bak/cli exec bak serve --port 17373 --rpc-ws-port 17374
```

4) Load extension in Chrome/Edge:
- Open `chrome://extensions` (or `edge://extensions`)
- Enable Developer mode
- Load unpacked: `packages/extension/dist`
- Open extension popup
- Paste token from `bak pair`, keep port `17373`, click `Save & Connect`

5) Run demo script (record + actions + snapshot + skill run):

```powershell
pwsh ./scripts/demo-rpc.ps1
```

## JSON-RPC quick call examples

```powershell
pnpm --filter @bak/cli exec bak call --method session.create --params '{"clientName":"demo"}'
pnpm --filter @bak/cli exec bak call --method page.goto --params '{"url":"http://127.0.0.1:4173/form.html"}'
pnpm --filter @bak/cli exec bak call --method element.type --params '{"locator":{"css":"#name-input"},"text":"hello"}'
pnpm --filter @bak/cli exec bak call --method page.snapshot --params '{}'
pnpm --filter @bak/cli exec bak doctor
pnpm --filter @bak/cli exec bak export --out ./.bak-data/diag.zip
```

## Memory CLI commands

```powershell
pnpm --filter @bak/cli exec bak record start --intent "fill form"
pnpm --filter @bak/cli exec bak record stop --outcome success
pnpm --filter @bak/cli exec bak skills list
pnpm --filter @bak/cli exec bak skills retrieve --intent "fill form" --anchor save
pnpm --filter @bak/cli exec bak skills run <skillId> --param param_1=Alice --param param_2=alice@example.com
pnpm --filter @bak/cli exec bak skills delete <skillId>
pnpm --filter @bak/cli exec bak memory migrate
pnpm --filter @bak/cli exec bak memory export --backend sqlite
```

Memory backend selection:
- default: `json` (`.bak-data/memory.json`)
- opt-in sqlite: set `BAK_MEMORY_BACKEND=sqlite` (uses `.bak-data/memory.sqlite`)

## Trace / snapshot output

Default data root: `./.bak-data`

- snapshots: `.bak-data/snapshots/<traceId>/...`
- traces: `.bak-data/traces/<traceId>.jsonl`
- memory db file: `.bak-data/memory.json`
- pairing token: `.bak-data/pairing.json`

### Retention and cleanup

`bak gc` is dry-run by default and only deletes files with `--force`.

```powershell
# preview what would be deleted
pnpm --filter @bak/cli exec bak gc

# apply retention with explicit force
pnpm --filter @bak/cli exec bak gc --trace-days 7 --snapshot-days 7 --force
```

Retention defaults (override via `.bak-data/retention.json` or env):
- traces: keep 14 days + newest 200
- snapshots: keep 14 days + newest 100

### Policy guardrails

The CLI checks a local policy file before `element.click` / `element.type`:
- default path: `.bak-data/.bak-policy.json`
- override path: `BAK_POLICY_PATH`
- decisions: `allow`, `deny`, `requireConfirm`

## Safety defaults

- Extension only connects to `ws://127.0.0.1`
- CLI/extension token pairing required
- High-risk actions require user approval overlay (`submit/delete/send/upload` semantics)
- Sensitive input masking in record traces (basic)
- Snapshot element maps avoid `input.value`; richer capture is explicit opt-in in popup
- No cookie/password exfiltration features

See `docs/SECURITY.md` and `docs/PRIVACY.md` for defaults and operational guidance.
