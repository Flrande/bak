# Memory Guide

Memory lets BAK learn repeatable page workflows and replay them with parameters.

## Typical Flow

### 1) Record

```powershell
bak record start --intent "create ticket"
# perform actions in browser
bak record stop --outcome success
```

### 2) Inspect

```powershell
bak skills list
bak skills show <skillId>
```

### 3) Retrieve

```powershell
bak skills retrieve --intent "create ticket" --anchor submit --anchor assignee
```

### 4) Run

```powershell
bak skills run <skillId> --param param_1=alice --param param_2=high
```

## Storage Backends

- Default: JSON (`.bak-data/memory.json`)
- Optional: SQLite (`.bak-data/memory.sqlite`)

Migrate and export:

```powershell
bak memory migrate
bak memory export --backend sqlite
```

## Sensitive Input

- Typed text is redacted in memory by default.
- Set `BAK_MEMORY_RECORD_INPUT_TEXT=1` only for explicit debugging windows.

## Replay Reliability

- Record clear intent text.
- Include stable anchors in flows.
- Keep workflows page-specific when possible.
- Validate replay with `bak page wait` after critical steps.
