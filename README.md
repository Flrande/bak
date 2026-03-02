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
    README.md
    user/
    developer/
    reference/
    PROTOCOL_V2.md
    PROTOCOL.md
    CAPABILITY_MATRIX.md
    E2E_MATRIX.md
    RELEASE_CAPABILITY_REPORT.md
  scripts/
    demo-rpc.ps1
```

## Documentation

- Start here: `docs/README.md`
- User path: `docs/user/README.md`
- Developer path: `docs/developer/README.md`
- Reference path: `docs/reference/README.md`

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

Build once before invoking the CLI binary:

```powershell
pnpm build
```

Then run commands from repo root:

```powershell
node packages/cli/dist/bin.js serve --port 17373
```

## Pairing + launch demo (manual)

1) Start test site:

```powershell
pnpm --filter @flrande/bak-test-sites dev
```

2) Generate pair token:

```powershell
node packages/cli/dist/bin.js pair
node packages/cli/dist/bin.js pair status
# revoke current token if needed
node packages/cli/dist/bin.js pair revoke
```

3) Start daemon:

```powershell
node packages/cli/dist/bin.js serve --port 17373 --rpc-ws-port 17374
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
node packages/cli/dist/bin.js call --method session.create --params '{"clientName":"demo"}'
node packages/cli/dist/bin.js call --method page.goto --params '{"url":"http://127.0.0.1:4173/form.html"}'
node packages/cli/dist/bin.js call --method element.type --params '{"locator":{"css":"#name-input"},"text":"hello"}'
node packages/cli/dist/bin.js call --method page.snapshot --params '{}'
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js export --out ./.bak-data/diag.zip
# include visual snapshot folders explicitly (contains raw screenshots)
node packages/cli/dist/bin.js export --trace-id <traceId> --include-snapshots --out ./.bak-data/diag-with-images.zip
```

`bak export` now generates a redacted diagnostic zip package. Use `--trace-id` (or deprecated alias `--trace`) to limit to one trace set.
Snapshot images are excluded by default and require explicit `--include-snapshots`.

## Memory CLI commands

```powershell
node packages/cli/dist/bin.js record start --intent "fill form"
node packages/cli/dist/bin.js record stop --outcome success
node packages/cli/dist/bin.js skills list
node packages/cli/dist/bin.js skills retrieve --intent "fill form" --anchor save
node packages/cli/dist/bin.js skills run <skillId> --param param_1=Alice --param param_2=alice@example.com
node packages/cli/dist/bin.js skills delete <skillId>
node packages/cli/dist/bin.js memory migrate
node packages/cli/dist/bin.js memory export --backend sqlite
```

Memory backend selection:
- default: `json` (`.bak-data/memory.json`)
- opt-in sqlite: set `BAK_MEMORY_BACKEND=sqlite` (uses `.bak-data/memory.sqlite`; `node:sqlite` runtime is currently experimental on Node 22)
- episode input text recording: default redacted (`[REDACTED:input]`); set `BAK_MEMORY_RECORD_INPUT_TEXT=1` to keep redacted textual hints

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
node packages/cli/dist/bin.js gc

# apply retention with explicit force
node packages/cli/dist/bin.js gc --trace-days 7 --snapshot-days 7 --force
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


