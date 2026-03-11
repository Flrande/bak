# Capability Matrix

| Domain | Method | Stability | Request/Response Schema | E2E Case IDs | CaseMapped |
| --- | --- | --- | --- | --- | --- |
| context | context.enterFrame | beta | `MethodMap['context.enterFrame']` | M001-S, M001-F | true |
| context | context.enterShadow | beta | `MethodMap['context.enterShadow']` | M002-S, M002-F | true |
| context | context.exitFrame | beta | `MethodMap['context.exitFrame']` | M003-S, M003-F | true |
| context | context.exitShadow | beta | `MethodMap['context.exitShadow']` | M004-S, M004-F | true |
| context | context.reset | beta | `MethodMap['context.reset']` | M005-S, M005-F | true |
| debug | debug.dumpState | beta | `MethodMap['debug.dumpState']` | M006-S, M006-F | true |
| debug | debug.getConsole | stable | `MethodMap['debug.getConsole']` | M007-S, M007-F | true |
| element | element.blur | stable | `MethodMap['element.blur']` | M008-S, M008-F | true |
| element | element.check | stable | `MethodMap['element.check']` | M009-S, M009-F | true |
| element | element.click | stable | `MethodMap['element.click']` | M010-S, M010-F | true |
| element | element.doubleClick | stable | `MethodMap['element.doubleClick']` | M011-S, M011-F | true |
| element | element.dragDrop | stable | `MethodMap['element.dragDrop']` | M012-S, M012-F | true |
| element | element.focus | stable | `MethodMap['element.focus']` | M013-S, M013-F | true |
| element | element.get | stable | `MethodMap['element.get']` | M014-S, M014-F | true |
| element | element.hover | stable | `MethodMap['element.hover']` | M015-S, M015-F | true |
| element | element.rightClick | stable | `MethodMap['element.rightClick']` | M016-S, M016-F | true |
| element | element.scroll | stable | `MethodMap['element.scroll']` | M017-S, M017-F | true |
| element | element.scrollIntoView | stable | `MethodMap['element.scrollIntoView']` | M018-S, M018-F | true |
| element | element.select | stable | `MethodMap['element.select']` | M019-S, M019-F | true |
| element | element.type | stable | `MethodMap['element.type']` | M020-S, M020-F | true |
| element | element.uncheck | stable | `MethodMap['element.uncheck']` | M021-S, M021-F | true |
| file | file.upload | stable | `MethodMap['file.upload']` | M022-S, M022-F | true |
| keyboard | keyboard.hotkey | stable | `MethodMap['keyboard.hotkey']` | M023-S, M023-F | true |
| keyboard | keyboard.press | stable | `MethodMap['keyboard.press']` | M024-S, M024-F | true |
| keyboard | keyboard.type | stable | `MethodMap['keyboard.type']` | M025-S, M025-F | true |
| mouse | mouse.click | stable | `MethodMap['mouse.click']` | M047-S, M047-F | true |
| mouse | mouse.move | stable | `MethodMap['mouse.move']` | M048-S, M048-F | true |
| mouse | mouse.wheel | stable | `MethodMap['mouse.wheel']` | M049-S, M049-F | true |
| network | network.clear | beta | `MethodMap['network.clear']` | M050-S, M050-F | true |
| network | network.get | beta | `MethodMap['network.get']` | M051-S, M051-F | true |
| network | network.list | beta | `MethodMap['network.list']` | M052-S, M052-F | true |
| network | network.waitFor | beta | `MethodMap['network.waitFor']` | M053-S, M053-F | true |
| page | page.accessibilityTree | beta | `MethodMap['page.accessibilityTree']` | M054-S, M054-F | true |
| page | page.back | stable | `MethodMap['page.back']` | M055-S, M055-F | true |
| page | page.dom | stable | `MethodMap['page.dom']` | M056-S, M056-F | true |
| page | page.forward | stable | `MethodMap['page.forward']` | M057-S, M057-F | true |
| page | page.goto | stable | `MethodMap['page.goto']` | M058-S, M058-F | true |
| page | page.metrics | stable | `MethodMap['page.metrics']` | M059-S, M059-F | true |
| page | page.reload | stable | `MethodMap['page.reload']` | M060-S, M060-F | true |
| page | page.scrollTo | stable | `MethodMap['page.scrollTo']` | M061-S, M061-F | true |
| page | page.snapshot | stable | `MethodMap['page.snapshot']` | M062-S, M062-F | true |
| page | page.text | stable | `MethodMap['page.text']` | M063-S, M063-F | true |
| page | page.title | stable | `MethodMap['page.title']` | M064-S, M064-F | true |
| page | page.url | stable | `MethodMap['page.url']` | M065-S, M065-F | true |
| page | page.viewport | stable | `MethodMap['page.viewport']` | M066-S, M066-F | true |
| page | page.wait | stable | `MethodMap['page.wait']` | M067-S, M067-F | true |
| session | session.close | stable | `MethodMap['session.close']` | M068-S, M068-F | true |
| session | session.create | stable | `MethodMap['session.create']` | M069-S, M069-F | true |
| session | session.info | stable | `MethodMap['session.info']` | M070-S, M070-F | true |
| tabs | tabs.close | stable | `MethodMap['tabs.close']` | M071-S, M071-F | true |
| tabs | tabs.focus | stable | `MethodMap['tabs.focus']` | M072-S, M072-F | true |
| tabs | tabs.get | stable | `MethodMap['tabs.get']` | M073-S, M073-F | true |
| tabs | tabs.getActive | stable | `MethodMap['tabs.getActive']` | M074-S, M074-F | true |
| tabs | tabs.list | stable | `MethodMap['tabs.list']` | M075-S, M075-F | true |
| tabs | tabs.new | stable | `MethodMap['tabs.new']` | M076-S, M076-F | true |

`CaseMapped=true` means the method is indexed in the e2e matrix. It does not imply that the case ran in CI.

