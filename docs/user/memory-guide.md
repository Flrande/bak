# Memory Guide

Memory lets BAK learn repeatable website workflows and replay them with parameters.

## Typical Flow

### 1) Record

```powershell
npx bak record start --intent "create ticket"
# perform actions in browser
npx bak record stop --outcome success
```

### 2) Inspect

```powershell
npx bak skills list
npx bak skills show <skillId>
```

### 3) Retrieve

```powershell
npx bak skills retrieve --intent "create ticket" --anchor submit --anchor assignee
```

### 4) Run

```powershell
npx bak skills run <skillId> --param param_1=alice --param param_2=high
```

## Storage Backends

- Default: JSON (`.bak-data/memory.json`)
- Optional: SQLite (`.bak-data/memory.sqlite`)

Migrate and export:

```powershell
npx bak memory migrate
npx bak memory export --backend sqlite
```

## Sensitive Input Handling

- Typed input is redacted in memory by default.
- Set `BAK_MEMORY_RECORD_INPUT_TEXT=1` only when you explicitly need richer debugging context.

## Replay Reliability Tips

- Record with clear intent text.
- Include stable anchors in the workflow.
- Keep flows page-specific where possible instead of broad domain-only habits.
