# 统一提问服务：隔离原型

验证问题：让手机和桌面读取同一份问题状态，能否在同时提交、网络结果未知、刷新和重连时，仍然只保存一次回答，并同步关闭回答入口？

这是独立实验，保存在 `codex/unified-question-prototype` 分支。默认预览不加载 Codex 配置、真实会话或用户凭据，不调用现有 Mini、App Server 或中继。可选 MCP 接入仅供明确指定的隔离测试对话使用。界面沿用 `public/index.html` 的卡片色彩、展开选项、自定义回答和按钮样式。

## 运行

使用 Node.js 24（本次实测 24.19.0，使用内置 `node:sqlite`；不改变主项目的 Node 版本要求）。无需新增依赖：

```powershell
npm.cmd run prototype:questions
```

启动窗口给出桌面和手机视图两个访问链接，默认监听 `127.0.0.1:18789`。两个页面连接同一个问题。访问密钥会换成 HttpOnly、SameSite=Strict cookie 并从地址栏移除。常规启动使用随机密钥；仅供自动测试的 `browser-fixture.js` 使用固定的测试密钥，应在验收后停止。

这两个链接目前仅供本机访问，手机视图指浏览器移动视口，不是公网手机入口。Ctrl+C 结束原型。数据放在 `output/question-prototype/PROTOTYPE-*`，与真实记录分开，目录被 Git 忽略。

每次普通启动创建新的实验数据。要恢复同一实验，明确指定其原目录：

```powershell
npm.cmd run prototype:questions -- --port 18789 --data-dir output/question-prototype/PROTOTYPE-实际目录名
```

## 状态和保证

- 调用方必须给出稳定且全局唯一的 `id` 与 `threadId`。相同 ID、相同内容重复建题返回已有问题；换内容则拒绝。文字相同但 ID 不同视为不同问题。
- SQLite `answers.question_id` 主键、`BEGIN IMMEDIATE` 事务与唯一收据保证同一问题只有一条已确认答案；答案和状态事件一起提交，落盘失败不确认成功。
- 同一个 `requestId` 的相同重试返回原收据；不同答案或其他提交者收到 409 与当前结果。不会把回答包装成普通聊天消息。
- 前台页面每秒读取完整快照，隐藏页面暂停轮询，恢复可见后立即读取。使用单调版本号防止旧快照覆盖新结果；没有 WebSocket 或会话接管。
- 写请求失败后先读回状态。未保存时用户可按原提交编号重试；已经保存时直接显示结果。不会自动重放写请求。
- 回答后两端关闭输入控件并展示同一份结果；另一端尚未提交的不同内容保留在“保留的未发送内容”。本页草稿、收起状态和未知提交编号保存在 sessionStorage。
- `ask.js` 是最小调用方：建题、等待、返回带收据的 canonical answer。可选 `mcp.js` 在此基础上使用服务端一次性领取记录，防止重复工具调用重新返回答案正文。

接口均位于 `/question-prototype/api`，由独立密钥保护：

| 请求 | 用途 |
| --- | --- |
| `POST /questions` | 以稳定 ID 创建问题 |
| `GET /questions` | 读取一致的完整快照 |
| `POST /questions/:id/answer` | 原子确认回答，body 为 `requestId/value/client` |
| `GET /questions/:id/result` | 调用方只读获取答案和收据 |
| `POST /questions/:id/claim-delivery` | 绑定工具身份一次性领取；浏览器禁止访问 |

## 可复现校验

```powershell
npm.cmd run prototype:questions:check
```

该命令创建并清理自己的临时数据库，覆盖 20 请求竞争、两个 Node 进程竞争、事务失败回滚、幂等重试、调用方单次返回和服务重启恢复。

浏览器校验通过宿主 Playwright 插件运行，无需安装 Playwright npm 依赖：

1. `node lib/question-service-prototype/browser-fixture.js`。
2. 在 `browser_run_code_unsafe` 中以 `filename` 执行 `lib/question-service-prototype/browser-check.js`。
3. 两个隔离浏览器 context 在成功后保留，用于额外的进程重启验证。停止 fixture 后确认两端显示断开；以 `node lib/question-service-prototype/browser-fixture.js <原目录>` 恢复，确认原 9 条答案和 revision 18 保留。
4. 关闭测试 context 并停止 fixture。截图位于 `output/playwright/question-prototype-*.png`，消费者的真实标准输出保存在 fixture 数据目录的 `consumer-result.json`。

浏览器测试正常流程全部连接真实 HTTP 服务和数据库。路由拦截只用于并发屏障、提交前断网、成功响应丢失、延迟旧快照，不伪造服务端接受答案的结果。

## 验证边界

已验证的去重范围是本原型的问题 ID、数据库状态、两份卡片页面和单次调用方。它不等同于任意外部任务的 exactly-once 执行保证：调用方跨进程重试也必须按收据去重。

真实 Codex App 对话已通过独立项目级 MCP 完成验收，临时注册已撤销。桌面使用 App 内浏览器里的独立卡片，手机为 Chromium 触摸/移动视口模拟，未使用实体手机。没有接入旧的原生 `request_user_input_async` 卡片或公网中继，也不自动更换现有对话的提问方式。

后续接入计划与验收记录见 `docs/validation/unified-question-prototype-2026-10-18.md`。运行中的现有服务保持原配置。

## 可选的真实 App 隔离 MCP 验收

完整证据见 [真实 App 工具接入验收](../../docs/validation/unified-question-app-tool-2026-10-18.md)。适配器限定一个预绑定的问题，属于原型能力，不能直接作为全局提问服务安装。

```powershell
node lib/question-service-prototype/app-test-server.js <隔离测试对话ID>
npm.cmd run prototype:questions:mcp-check
```

启动器使用独立端口 18792、随机浏览器密钥和不同的工具密钥，生成 `mcp-binding.json`。绑定文件只留在忽略的实验目录，不提交到 Git。仅在专用且受信的测试目录中临时配置：

```toml
[mcp_servers.unified_question_isolated]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Projects\Codex-Mini\lib\question-service-prototype\mcp.js', '--binding', '<启动器输出的绑定文件绝对路径>']
startup_timeout_sec = 10
tool_timeout_sec = 180
enabled = true
enabled_tools = ['ask_question']
```

不要在正式项目或全局添加该 MCP。现有聊天需重新初始化才能刷新工具列表。本次使用 App 会话管理接口仅归档/恢复测试对话，保留其历史；验收后撤销测试配置与临时信任。一次等待最长 160 秒，超时不自动重新提问。

服务端限制工具只能操作绑定问题，不能替用户回答。领取结果后若传输丢失，返回/记录 `delivery_uncertain`，保留记录等待核对，不能把它当作未投递而盲目重试。重复领取返回 `already_claimed`，不再包含答案正文。

`audit-app-run.js <测试目录> <rollout.jsonl> [报告.json]` 可只读核对真实 MCP 完成事件、模型可见工具结果、模型最终回显和数据库计数，区分同一事件的多份日志投影。
