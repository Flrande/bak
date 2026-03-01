# Capability Matrix

| Domain | Method | Stability | Request/Response Schema | E2E Case IDs | Covered |
| --- | --- | --- | --- | --- | --- |
| context | context.enterFrame | beta | `MethodMap['context.enterFrame']` | M045-S, M045-F | true |
| context | context.enterShadow | experimental | `MethodMap['context.enterShadow']` | M047-S, M047-F | true |
| context | context.exitFrame | beta | `MethodMap['context.exitFrame']` | M046-S, M046-F | true |
| context | context.exitShadow | experimental | `MethodMap['context.exitShadow']` | M048-S, M048-F | true |
| context | context.reset | beta | `MethodMap['context.reset']` | M049-S, M049-F | true |
| debug | debug.dumpState | stable | `MethodMap['debug.dumpState']` | M055-S, M055-F | true |
| debug | debug.getConsole | stable | `MethodMap['debug.getConsole']` | M054-S, M054-F | true |
| element | element.blur | stable | `MethodMap['element.blur']` | M036-S, M036-F | true |
| element | element.check | stable | `MethodMap['element.check']` | M032-S, M032-F | true |
| element | element.click | stable | `MethodMap['element.click']` | M024-S, M024-F | true |
| element | element.doubleClick | stable | `MethodMap['element.doubleClick']` | M028-S, M028-F | true |
| element | element.dragDrop | stable | `MethodMap['element.dragDrop']` | M030-S, M030-F | true |
| element | element.focus | stable | `MethodMap['element.focus']` | M035-S, M035-F | true |
| element | element.get | stable | `MethodMap['element.get']` | M037-S, M037-F | true |
| element | element.hover | stable | `MethodMap['element.hover']` | M027-S, M027-F | true |
| element | element.rightClick | stable | `MethodMap['element.rightClick']` | M029-S, M029-F | true |
| element | element.scroll | stable | `MethodMap['element.scroll']` | M026-S, M026-F | true |
| element | element.scrollIntoView | stable | `MethodMap['element.scrollIntoView']` | M034-S, M034-F | true |
| element | element.select | stable | `MethodMap['element.select']` | M031-S, M031-F | true |
| element | element.type | stable | `MethodMap['element.type']` | M025-S, M025-F | true |
| element | element.uncheck | stable | `MethodMap['element.uncheck']` | M033-S, M033-F | true |
| file | file.upload | stable | `MethodMap['file.upload']` | M044-S, M044-F | true |
| keyboard | keyboard.hotkey | stable | `MethodMap['keyboard.hotkey']` | M040-S, M040-F | true |
| keyboard | keyboard.press | stable | `MethodMap['keyboard.press']` | M038-S, M038-F | true |
| keyboard | keyboard.type | stable | `MethodMap['keyboard.type']` | M039-S, M039-F | true |
| memory | memory.episodes.list | beta | `MethodMap['memory.episodes.list']` | M064-S, M064-F | true |
| memory | memory.recordStart | beta | `MethodMap['memory.recordStart']` | M056-S, M056-F | true |
| memory | memory.recordStop | beta | `MethodMap['memory.recordStop']` | M057-S, M057-F | true |
| memory | memory.replay.explain | beta | `MethodMap['memory.replay.explain']` | M065-S, M065-F | true |
| memory | memory.skills.delete | beta | `MethodMap['memory.skills.delete']` | M062-S, M062-F | true |
| memory | memory.skills.list | beta | `MethodMap['memory.skills.list']` | M058-S, M058-F | true |
| memory | memory.skills.retrieve | beta | `MethodMap['memory.skills.retrieve']` | M060-S, M060-F | true |
| memory | memory.skills.run | beta | `MethodMap['memory.skills.run']` | M061-S, M061-F | true |
| memory | memory.skills.show | beta | `MethodMap['memory.skills.show']` | M059-S, M059-F | true |
| memory | memory.skills.stats | beta | `MethodMap['memory.skills.stats']` | M063-S, M063-F | true |
| mouse | mouse.click | stable | `MethodMap['mouse.click']` | M042-S, M042-F | true |
| mouse | mouse.move | stable | `MethodMap['mouse.move']` | M041-S, M041-F | true |
| mouse | mouse.wheel | stable | `MethodMap['mouse.wheel']` | M043-S, M043-F | true |
| network | network.clear | beta | `MethodMap['network.clear']` | M053-S, M053-F | true |
| network | network.get | beta | `MethodMap['network.get']` | M051-S, M051-F | true |
| network | network.list | beta | `MethodMap['network.list']` | M050-S, M050-F | true |
| network | network.waitFor | beta | `MethodMap['network.waitFor']` | M052-S, M052-F | true |
| page | page.accessibilityTree | beta | `MethodMap['page.accessibilityTree']` | M020-S, M020-F | true |
| page | page.back | stable | `MethodMap['page.back']` | M011-S, M011-F | true |
| page | page.dom | stable | `MethodMap['page.dom']` | M019-S, M019-F | true |
| page | page.forward | stable | `MethodMap['page.forward']` | M012-S, M012-F | true |
| page | page.goto | stable | `MethodMap['page.goto']` | M010-S, M010-F | true |
| page | page.metrics | stable | `MethodMap['page.metrics']` | M023-S, M023-F | true |
| page | page.reload | stable | `MethodMap['page.reload']` | M013-S, M013-F | true |
| page | page.scrollTo | stable | `MethodMap['page.scrollTo']` | M021-S, M021-F | true |
| page | page.snapshot | stable | `MethodMap['page.snapshot']` | M015-S, M015-F | true |
| page | page.text | stable | `MethodMap['page.text']` | M018-S, M018-F | true |
| page | page.title | stable | `MethodMap['page.title']` | M016-S, M016-F | true |
| page | page.url | stable | `MethodMap['page.url']` | M017-S, M017-F | true |
| page | page.viewport | stable | `MethodMap['page.viewport']` | M022-S, M022-F | true |
| page | page.wait | stable | `MethodMap['page.wait']` | M014-S, M014-F | true |
| session | session.close | stable | `MethodMap['session.close']` | M002-S, M002-F | true |
| session | session.create | stable | `MethodMap['session.create']` | M001-S, M001-F | true |
| session | session.info | stable | `MethodMap['session.info']` | M003-S, M003-F | true |
| tabs | tabs.close | stable | `MethodMap['tabs.close']` | M007-S, M007-F | true |
| tabs | tabs.focus | stable | `MethodMap['tabs.focus']` | M005-S, M005-F | true |
| tabs | tabs.get | stable | `MethodMap['tabs.get']` | M009-S, M009-F | true |
| tabs | tabs.getActive | stable | `MethodMap['tabs.getActive']` | M008-S, M008-F | true |
| tabs | tabs.list | stable | `MethodMap['tabs.list']` | M004-S, M004-F | true |
| tabs | tabs.new | stable | `MethodMap['tabs.new']` | M006-S, M006-F | true |

反查规则：从任意 Method 可直接定位到 `E2E Case IDs`，再通过 `docs/E2E_MATRIX.md` 查询 CI 状态。

