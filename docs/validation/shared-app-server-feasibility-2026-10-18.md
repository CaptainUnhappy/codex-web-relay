# Web 与 Codex App 共用 Server：可行性与卡片确认验证

日期：2026-10-18（Asia/Taipei）。本次仅调查及隔离实验，没有迁移正在运行的 App/Mini 配置。

## 结论

连接和原生协议层存在可行的共享 Server 路径，不能继续把“Windows App 完全不能连接外部 WebSocket”作为阻塞理由。但仅共享 Server 不足以修复当前 Desktop `request_user_input_async` 卡片不关闭、允许再次提交的问题。

| 检查项 | 本次实际结果 | 能证明什么 |
| --- | --- | --- |
| 两个客户端连接同一个原生 Server、恢复同一 thread | 通过 | 一个运行中的 Server 可以服务两个客户端 |
| Goal 更新广播 | 两端均收到 | 状态通知可以共享 |
| 原生 `item/tool/requestUserInput` | 两端收到同一个 request ID | 原生问答有统一的待答请求 |
| Web 客户端回答原生请求 | 两端均收到 `serverRequest/resolved`，模型输入只有一份答案 | 原生请求确认和重复回答防护可共享 |
| 另一客户端重复回答已解决的原生 request ID | 第二答案没有进入模型输入 | 原生请求不会接受第二次回答 |
| 两端把同一异步回答包装作为普通用户消息提交 | 同一个 Server 持久保存两条相同消息 | 共享 Server 不会自动按包装内的 question ID 去重 |
| App 原有异步卡片状态函数 | 外部答案可更新 lastSubmission，但所选卡片仍保留 | 消息同步与卡片关闭不是同一个动作 |

最后一项是当前安装包原函数的离线复现；没有把它冒充为“真实 App 已切入共享 Server 后的完整 UI 验收”。普通消息对照使用合成 question ID，用于检验 Server 是否自动识别该包装；真实 App 卡片的行为由独立的原函数审计及用户之前的实际现象共同约束。

## 当前实际进程

只读检查时：

- App 关联原生 Server PID `111068`：WebSocket，认证模式 `capability-token`，二进制来自 App 安装的 runtime，CLI 版本 `0.162.0-alpha.17.2`。
- Mini 原生 Server PID `106708`：stdio，二进制来自项目 `.runtime/codex-cli-bin`，版本 `0.159.0`。

PID 只代表本次检查瞬间。未读取认证口令，记录中不保存认证摘要或完整启动参数。App 外层可能使用 stdio 启动代理，再由代理启动带认证的 WS 子服务；外层 transport 名称不等于内部 Server 实际传输，也不代表 Mini 已被授权连接它。

## App 连接入口：纠正 WSL 与 Windows 的混淆

App 包：`OpenAI.Codex_26.1007.2314.0`。以下为 JS 字符偏移。

1. `.vite/build/main-BklS_2Y2.js` 的 `j5`（3244728）按 host 选择 transport。其 `r.Wi(hostConfig)` 分支会选择 `vYe` stdio wrapper。
2. 解开 `r` 的真实模块 `.vite/build/src-CP7XXlpZ.js` 导出后，`Wi` 对应 `Mi`（43709），内容是 `host.kind === 'wsl'`，**不是普通 Windows local**。
3. 普通 local 会继续调用 `A5`，再调用网络模块 `Yo`（225836 附近）：读取 `CODEX_APP_SERVER_WS_URL` 或 `host.websocket_url`；`CODEX_APP_SERVER_FORCE_CLI=1` 会禁用该选择。
4. `scripts/audit-desktop-server-routing.js` 读取当前包的原始选择函数，仅用记录型构造器替代网络连接，实际得到：
   - Windows local 默认：stdio；
   - Windows local + `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4500`：WebSocket；
   - 同时 `CODEX_APP_SERVER_FORCE_CLI=1`：stdio；
   - WSL：WSL stdio wrapper。

这是安装包内部启动开关的代码证据，不是公开 UI 配置承诺。当前 local WS 分支没有附带自定义认证 handshake，现有 App 内部 Server 则启用了 capability-token。因此完整迁移仍要解决认证接入、App 工具/宿主连接与兼容性，不能仅复制一个端口。未实际重启 App 验证环境变量启动或受认证共享连接。

## 真实双客户端实验

脚本：`scripts/test-shared-server-e2e.js`。

- 启动与当前 App 同版本的原生 `codex.exe app-server --listen ws://127.0.0.1:<随机端口>`。
- 使用本项目 output 下的独立临时 `CODEX_HOME`；不加载用户会话、登录或真实模型凭据。
- 本地固定 Responses SSE provider 仅生成一次原生提问、后续完成消息；没有调用真实模型。
- A/B 各自 initialize，A 新建测试 thread、B resume 同 thread；两端同时接收原生提问与 resolved 通知。
- B 提交答案，A 再提交相同 request ID；provider 只收到一个工具结果，重复答案没有进入后续输入。
- A/B 分别提交相同异步回答包装的普通消息，thread/read 返回两条匹配消息。
- B 断开后 A 仍能读取 Goal，Server 继续运行。
- 测试结束只终止脚本自己启动的进程树，校验目录边界后清理 fixture；最终运行退出码 0。早期清理等待/Windows 文件占用已修正，不把仅断言通过但清理失败的运行当作完整通过。

最终结果：`sameThreadResume=true`、`nativeQuestionBroadcast=true`、`resolutionBroadcast=true`、`acceptedNativeAnswers=1`、`duplicateNativeAnswerRejected=true`、`ordinaryEnvelopeDuplicateMessages=2`、`webDisconnectKeepsServerAlive=true`。共 4 次本地 fixture 响应。

复现命令：

```powershell
node scripts/test-shared-server-e2e.js 'C:\Users\Unhappy\AppData\Local\OpenAI\Codex\bin\2e5e00daee91c61d\codex.exe'
node scripts/audit-desktop-server-routing.js 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\app\resources\app.asar'
node scripts/audit-desktop-question-reconciliation.js 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\app\resources\app.asar'
```

两个新增脚本均通过 `node --check`，上述三类实验已执行。App 原函数审计仍得到：同 turn 外部答案已识别、卡片保留；新 turn 外部答案不回溯原问题、卡片保留；本地提交成功回调收起卡片。

## 真正实现所需的改动

共享架构可采用：手机 → 现有认证中继 → Mini WS 客户端 → 独立原生 Server ← App WS 客户端。

1. **连接与生命周期**：Mini 增加 WS transport；分离“客户端连接”与“Server 进程”的所有权。当前 `_disconnectOwnedProcess` 结束自有子进程，不能用于共享 Server；手动/空闲释放只能取消本客户端订阅或关闭连接，不能结束 App 共用的进程。
2. **确认协议**：原生 request ID 已具备共享确认能力。但 Desktop 异步问题需接入真正的 question ID 提交/确认协议，或由 App 对已接受答案作一致的卡片协调；把包装继续当普通消息发送不满足要求。
3. **双向验收**：实际 App 与 Web 连接同一受认证实例后，手机回答必须让 App 失去重复提交入口；App 回答后 Web 同样失效。还必须覆盖新 turn、刷新、重连、双击和结果未知时不重放。

若目标仅是修复当前这张异步卡片，不应先把共享 Server 迁移当作完成修复。它可以作为统一进度、原生审批和原生提问的基础工程，异步卡片确认仍是单独的必要条件。原持续 Goal 仍未达到完成标准。
