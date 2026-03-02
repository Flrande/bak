# PROTOCOL V2

- Transport: JSON-RPC 2.0
- Compatibility: v1 and v2 clients can run concurrently (additive v2 methods).
- Canonical type source: `packages/protocol/src/types.ts` (`MethodMap`).

## Error Codes

- `E_NOT_PAIRED`
- `E_PERMISSION`
- `E_NOT_FOUND`
- `E_NEED_USER_CONFIRM`
- `E_TIMEOUT`
- `E_INVALID_PARAMS`
- `E_INTERNAL`
- `E_NOT_READY`

## Method Schemas

| Method | Request Schema | Response Schema | Error Codes | E2E Case IDs |
| --- | --- | --- | --- | --- |
| context.enterFrame | `MethodMap['context.enterFrame']['params']` | `MethodMap['context.enterFrame']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M045-S, M045-F |
| context.enterShadow | `MethodMap['context.enterShadow']['params']` | `MethodMap['context.enterShadow']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M047-S, M047-F |
| context.exitFrame | `MethodMap['context.exitFrame']['params']` | `MethodMap['context.exitFrame']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M046-S, M046-F |
| context.exitShadow | `MethodMap['context.exitShadow']['params']` | `MethodMap['context.exitShadow']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M048-S, M048-F |
| context.reset | `MethodMap['context.reset']['params']` | `MethodMap['context.reset']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M049-S, M049-F |
| debug.dumpState | `MethodMap['debug.dumpState']['params']` | `MethodMap['debug.dumpState']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M055-S, M055-F |
| debug.getConsole | `MethodMap['debug.getConsole']['params']` | `MethodMap['debug.getConsole']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M054-S, M054-F |
| element.blur | `MethodMap['element.blur']['params']` | `MethodMap['element.blur']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M036-S, M036-F |
| element.check | `MethodMap['element.check']['params']` | `MethodMap['element.check']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M032-S, M032-F |
| element.click | `MethodMap['element.click']['params']` | `MethodMap['element.click']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M024-S, M024-F |
| element.doubleClick | `MethodMap['element.doubleClick']['params']` | `MethodMap['element.doubleClick']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M028-S, M028-F |
| element.dragDrop | `MethodMap['element.dragDrop']['params']` | `MethodMap['element.dragDrop']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M030-S, M030-F |
| element.focus | `MethodMap['element.focus']['params']` | `MethodMap['element.focus']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M035-S, M035-F |
| element.get | `MethodMap['element.get']['params']` | `MethodMap['element.get']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M037-S, M037-F |
| element.hover | `MethodMap['element.hover']['params']` | `MethodMap['element.hover']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M027-S, M027-F |
| element.rightClick | `MethodMap['element.rightClick']['params']` | `MethodMap['element.rightClick']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M029-S, M029-F |
| element.scroll | `MethodMap['element.scroll']['params']` | `MethodMap['element.scroll']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M026-S, M026-F |
| element.scrollIntoView | `MethodMap['element.scrollIntoView']['params']` | `MethodMap['element.scrollIntoView']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M034-S, M034-F |
| element.select | `MethodMap['element.select']['params']` | `MethodMap['element.select']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M031-S, M031-F |
| element.type | `MethodMap['element.type']['params']` | `MethodMap['element.type']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M025-S, M025-F |
| element.uncheck | `MethodMap['element.uncheck']['params']` | `MethodMap['element.uncheck']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M033-S, M033-F |
| file.upload | `MethodMap['file.upload']['params']` | `MethodMap['file.upload']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M044-S, M044-F |
| keyboard.hotkey | `MethodMap['keyboard.hotkey']['params']` | `MethodMap['keyboard.hotkey']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M040-S, M040-F |
| keyboard.press | `MethodMap['keyboard.press']['params']` | `MethodMap['keyboard.press']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M038-S, M038-F |
| keyboard.type | `MethodMap['keyboard.type']['params']` | `MethodMap['keyboard.type']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M039-S, M039-F |
| memory.episodes.list | `MethodMap['memory.episodes.list']['params']` | `MethodMap['memory.episodes.list']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M064-S, M064-F |
| memory.recordStart | `MethodMap['memory.recordStart']['params']` | `MethodMap['memory.recordStart']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M056-S, M056-F |
| memory.recordStop | `MethodMap['memory.recordStop']['params']` | `MethodMap['memory.recordStop']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M057-S, M057-F |
| memory.replay.explain | `MethodMap['memory.replay.explain']['params']` | `MethodMap['memory.replay.explain']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M065-S, M065-F |
| memory.skills.delete | `MethodMap['memory.skills.delete']['params']` | `MethodMap['memory.skills.delete']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M062-S, M062-F |
| memory.skills.list | `MethodMap['memory.skills.list']['params']` | `MethodMap['memory.skills.list']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M058-S, M058-F |
| memory.skills.retrieve | `MethodMap['memory.skills.retrieve']['params']` | `MethodMap['memory.skills.retrieve']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M060-S, M060-F |
| memory.skills.run | `MethodMap['memory.skills.run']['params']` | `MethodMap['memory.skills.run']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M061-S, M061-F |
| memory.skills.show | `MethodMap['memory.skills.show']['params']` | `MethodMap['memory.skills.show']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M059-S, M059-F |
| memory.skills.stats | `MethodMap['memory.skills.stats']['params']` | `MethodMap['memory.skills.stats']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M063-S, M063-F |
| mouse.click | `MethodMap['mouse.click']['params']` | `MethodMap['mouse.click']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M042-S, M042-F |
| mouse.move | `MethodMap['mouse.move']['params']` | `MethodMap['mouse.move']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M041-S, M041-F |
| mouse.wheel | `MethodMap['mouse.wheel']['params']` | `MethodMap['mouse.wheel']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M043-S, M043-F |
| network.clear | `MethodMap['network.clear']['params']` | `MethodMap['network.clear']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M053-S, M053-F |
| network.get | `MethodMap['network.get']['params']` | `MethodMap['network.get']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M051-S, M051-F |
| network.list | `MethodMap['network.list']['params']` | `MethodMap['network.list']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M050-S, M050-F |
| network.waitFor | `MethodMap['network.waitFor']['params']` | `MethodMap['network.waitFor']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M052-S, M052-F |
| page.accessibilityTree | `MethodMap['page.accessibilityTree']['params']` | `MethodMap['page.accessibilityTree']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M020-S, M020-F |
| page.back | `MethodMap['page.back']['params']` | `MethodMap['page.back']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M011-S, M011-F |
| page.dom | `MethodMap['page.dom']['params']` | `MethodMap['page.dom']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M019-S, M019-F |
| page.forward | `MethodMap['page.forward']['params']` | `MethodMap['page.forward']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M012-S, M012-F |
| page.goto | `MethodMap['page.goto']['params']` | `MethodMap['page.goto']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M010-S, M010-F |
| page.metrics | `MethodMap['page.metrics']['params']` | `MethodMap['page.metrics']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M023-S, M023-F |
| page.reload | `MethodMap['page.reload']['params']` | `MethodMap['page.reload']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M013-S, M013-F |
| page.scrollTo | `MethodMap['page.scrollTo']['params']` | `MethodMap['page.scrollTo']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M021-S, M021-F |
| page.snapshot | `MethodMap['page.snapshot']['params']` | `MethodMap['page.snapshot']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M015-S, M015-F |
| page.text | `MethodMap['page.text']['params']` | `MethodMap['page.text']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M018-S, M018-F |
| page.title | `MethodMap['page.title']['params']` | `MethodMap['page.title']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M016-S, M016-F |
| page.url | `MethodMap['page.url']['params']` | `MethodMap['page.url']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M017-S, M017-F |
| page.viewport | `MethodMap['page.viewport']['params']` | `MethodMap['page.viewport']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M022-S, M022-F |
| page.wait | `MethodMap['page.wait']['params']` | `MethodMap['page.wait']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M014-S, M014-F |
| session.close | `MethodMap['session.close']['params']` | `MethodMap['session.close']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M002-S, M002-F |
| session.create | `MethodMap['session.create']['params']` | `MethodMap['session.create']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M001-S, M001-F |
| session.info | `MethodMap['session.info']['params']` | `MethodMap['session.info']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M003-S, M003-F |
| tabs.close | `MethodMap['tabs.close']['params']` | `MethodMap['tabs.close']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M007-S, M007-F |
| tabs.focus | `MethodMap['tabs.focus']['params']` | `MethodMap['tabs.focus']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M005-S, M005-F |
| tabs.get | `MethodMap['tabs.get']['params']` | `MethodMap['tabs.get']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M009-S, M009-F |
| tabs.getActive | `MethodMap['tabs.getActive']['params']` | `MethodMap['tabs.getActive']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M008-S, M008-F |
| tabs.list | `MethodMap['tabs.list']['params']` | `MethodMap['tabs.list']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M004-S, M004-F |
| tabs.new | `MethodMap['tabs.new']['params']` | `MethodMap['tabs.new']['result']` | E_INVALID_PARAMS,E_NOT_FOUND,E_TIMEOUT,E_PERMISSION,E_NOT_READY,E_INTERNAL | M006-S, M006-F |

## Domain DoD

- `tabs/page/element/input/file/frame/network/debug/memory` 全部域都要求：请求/响应 schema 完整、至少 1 成功 + 1 失败真实 e2e、trace 可追踪。
- `context.*` / `network.*` / `debug.*` 强制要求失败可解释（错误码 + trace 事件）。
- 若 `docs/RELEASE_CAPABILITY_REPORT.md` 中 `ReleaseGate` 为 `fail`，表示该 DoD 仍未满足，禁止按“已通过真实 e2e”对外声明。

## Backward Compatibility

- v1 方法全部保留并可运行。
- v2 在保持原字段不破坏的前提下追加新字段与新方法。

