# 桌面异步提问重复回复：根因与临时保护

日期：2026-10-18（Asia/Taipei）。

## 结论与交付边界

用户已实际遇到同一问题收到两次相同回答：手机提交后 App 卡片仍可操作，随后从 App 再次提交。之前只验证模型回显，没有验证 App 卡片确认状态，不能据此声称跨端回答完整成功。

本次阻止不完整的手机提交路径：Codex App 发起的 `request_user_input_async` 问题统一在 App 中回答；Web 只读显示问题并同步结果。Mini 连接自己收到的原生 `item/tool/requestUserInput` 提问仍可在 Web 回答。

这是一项防重复保护，尚未恢复“手机直接回答桌面异步问题并同步关闭 App 卡片”的完整能力。

## 已核实的实际调用链

Mini 的 `CodexAppServerBackend` 启动独立的 `codex app-server --listen stdio://` 子进程。旧实现将桌面问题答案构造成 `<send_user_message_question_reply>` 用户消息，再调用 Mini 的发送/排队流程。它共享持久消息和原生队列，不共享 Desktop 的问题卡片确认回调。

当前实际桌面应用包：`OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0`，运行程序为包内 `ChatGPT.exe`。只读检查 `app.asar`，未修改应用、数据库或 rollout：

- `webview/assets/app-shared-737655e1fb23.js`：`F5t` 生成 `questionItemId`；`I5t` 生成回答包装；`tV` 解析包装，支持数组或单对象。包装只有 `questionItemId`、`question`、`answer`，没有可补传的卡片确认字段。
- 同文件 `V5t / K5t / G5t` 根据本地 turn items 识别问题及回答；这种识别不能代替本地卡片状态的提交成功回调。
- `webview/assets/app-primary-19fe57fd8c00.js`，偏移约 533777：本地异步问题提交构造 `turnTrigger: send_user_message_async_question`，调用 `vAe(..., {queueModeOverride: send-now})`；成功后显式调用 `A$e`。
- 同文件偏移约 530666：`A$e` 更新问题草稿/已提交状态，全部确认后调用 `DRe(..., null)` 清理卡片。这段提交回调不因 Mini 追加普通用户消息而执行。另有历史观察器会同步已答状态，但不等同于收起已选中的卡片，详见下文补充复现。

因此，单纯把 Mini 改成连接同一个 App Server，也没有证据保证会触发 App 的卡片确认动作。没有找到当前版本向外部开放的本地异步问题确认接口。Electron 内部 WebContents IPC 和云端 conversation 问答接口均不能当作该接口使用。

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput)描述的 `item/tool/requestUserInput` / `serverRequest/resolved` 属于原生请求响应协议；它与这里的桌面 `request_user_input_async` 用户消息问题不是同一条路径。

## 修改

1. 服务端 `/send` 在调用 backend 或原生队列前拒绝桌面 `questionReply`，返回 `409 / DESKTOP_QUESTION_REQUIRES_APP`。
2. 同时拒绝直接作为普通文本提交的有效回答包装，覆盖数组和单对象两种形式。旧网页和直接接口调用也不能绕过。
3. 桌面异步问题返回 `responseOwner: codex-app`、`canSubmit: false`；Web 明确显示“请在 Codex App 中回答”，不提供第二个提交入口。
4. 原生提问和审批继续通过原生请求 ID 回答。普通消息的幂等保护、未知结果不重放、会话占用与释放保持原样。
5. 旧回答与旧队列仍可读取，没有删除用户已经产生的重复历史。

防护边界：用户主动在普通输入框输入任意自然语言，仍然是一条普通消息；不能把任意相似文本都当作重复问题答案拦截。本次封闭的是错误的结构化回答旁路。

## 自动检查与公网验证

- 修改前新增的“桌面答案不得绕过 App 确认”断言失败：旧路径返回 200，并调用 native send。
- 修改后 `scripts/test-user-input.js` 通过：旧客户端、数组包装、单对象包装均被拦截，native send 次数为 0；普通消息幂等及未知结果保护仍通过。
- `scripts/test-question-ui.js` 通过：Desktop 卡片无提交控件，旧回调也不发请求；原生选项、自由输入、失败重试、刷新恢复、切换会话、排队显示及 320／390／1024 px 布局通过。
- `npm.cmd run check` 全部通过；独立只读审查未发现阻塞问题。
- 在 Mini 无占用、无未确认操作时更新服务，只重启已核实归属的 Mini Node 进程，保留监督进程和 App。

真实隔离对话：`Web 提问交互端到端测试`，thread `01a14dcb-3bf7-7c60-9e10-ebb350f80a24`。

真实提问：`desktop-question:call_eee4002027d8429d8964f97f6394da24`，题目“单入口验收：请在 Codex App 中只提交一次。”。

通过公网实际探测三种提交：`questionReply`、原始数组包装、原始单对象包装。三次均返回 409 及 `DESKTOP_QUESTION_REQUIRES_APP`；队列数量前后均为 0；原问题仍未提交；Mini 占用线程为空，不确定操作为 0。Web 没有可提交控件。截图：`output/playwright/question-app-only-live.png`。

## App 单入口人工验收（已完成）

用户确认在 App 对“单入口验收”选择“确认一次”并发送一次，卡片已关闭。

随后通过 `read_thread` 核实 turn `01a14e2f-8ba9-79c1-afff-23dd3552485b`：只有一条对应原 question ID 的用户回答，模型只有一次 `ONE_ANSWER_CONFIRMED：确认一次`。公网 `/codex/approvals` 返回 0 项，`/codex/status` 队列为 0。该结果验证了 App 单入口防重复保护，不代表 Web 直接回答桌面异步问题的能力已经恢复。

## 恢复手机直接回答的后续要求

需要 App 提供受支持的原子确认入口：以 thread ID 和 question ID 识别原问题，用幂等键接受一次答案，同时更新卡片状态并向已连接客户端广播。两端均以同一状态版本决定是否可答。

验收必须覆盖：手机答一次后 App 不再可重复提交；App 答一次后手机不再可答；刷新与重新连接仍一致；网络断开或结果未知时不重放。单独增加普通消息去重、发送 `serverRequest/resolved` 假通知、改私有 atom/数据库、隐藏卡片或删除历史均不满足该条件。

## 继续审计：原生历史观察器的可重复复现

补充检查发现此前未完整追踪的 `app-initial-b8e1c8014bb4.js` 导入链，修正“只有本地提交回调能更新问题状态”的过强表述。以下偏移均为 JS 字符偏移，不是字节偏移。

- `app-primary` 导入 `yKn as DRe`、`gKn as Gw`，来源是 `app-initial`；其导出实际对应 `HS`、`OIt`。不能直接在 `app-shared` 查同名混淆符号。
- `app-initial` 的 `lIt`（1323910）观察历史 turn/items，调用 `mIt`（1324610）；后者调用 shared 的 `exr`（4937689）构造 `answersByQuestionItemId`，更新 `WS.lastSubmission / draftBaseline / draft`。
- `mIt` 同时保留本 turn 的全部问题 ID。只有问题从 items 消失、或所选问题不再属于该列表时，它才调用 `HS(..., null)`。收到同 turn 已 accepted 的答案，问题本身仍存在，因此所选卡片仍保留。
- 新 turn 的普通回答没有同 turn 问题可关联；它不回溯清理上一 turn 的所选卡片。
- App 本地提交成功回调 `A$e`（530666）有额外的匹配答案/草稿检查和 `DRe(..., null)`，会收起卡片。

新增只读诊断脚本 `scripts/audit-desktop-question-reconciliation.js`，直接从已安装 ASAR 读取这些纯状态函数，在内存 atom store 中执行，不连接、不修改 App，且不分发 App 源代码。有效消息包装解析器为测试夹具；其余解析与协调函数来自原包。命令：

```powershell
node scripts/audit-desktop-question-reconciliation.js 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\app\resources\app.asar'
```

实际输出：

| 场景 | 问题答案状态更新 | 已选卡片保留 |
| --- | --- | --- |
| 同 turn 外部 accepted steering 答案 | 是 | 是 |
| 新 turn 外部普通答案 | 否（原问题） | 是 |
| App 本地提交成功回调 | 是 | 否 |

该结果证明现有状态协调逻辑存在差异，不代表运行中的 App UI 已得到修复，也不证明 Mini 可以借助私有函数完成稳定提交。原生包版本不变时，改普通消息格式、改 queue/steer 或等待历史刷新，均缺少让旧卡片完成确认的证据。

本轮也复核动态 App 工具的 native-pipe 注册：有 `tools/list`、`tools/call`、任务工作区和项目操作，未发现独立问题 answer/confirm 方法；入口具有 peer authorization 和签名上下文，不能当作匿名 Mini 桥接接口。

## 持续目标的完成与阻塞审计

当前状态不是完整修复。逐项审计：

| 原目标要求 | 当前证据 | 判定 |
| --- | --- | --- |
| 定位回答与确认路径 | 原生提交回调、历史观察器、消息协议、可执行离线复现 | 已定位 |
| Web 回答后 App 关闭卡片 | 当前安装包的外部答案复现仍保留已选卡片；无可调用的确认入口 | 未完成 |
| 跨客户端最多接受一次答案 | 只有临时 App 单入口保护；尚无共享原子确认状态 | 未完成 |
| 隔离对话双向端到端验证 | App 单次提交及 Web 保护已验证；Web 直接答复的完整方向尚未通过 | 未完成 |
| 仅本地提交 | 保护、功能和诊断分别有本地 commit；没有推送 | 已执行现有范围 |

本次重新读取安装注册，版本仍为 `26.1007.2314.0`；重新运行诊断脚本，三个资源 SHA-256 与前次一致，三个场景结果均未改变。当前可用工具清单仍没有异步卡片 answer/confirm 工具。没有等待中的外部修复进程，重复审计不是“已验证的等待”。

从线程记录核对，缺少 App 确认入口这一条件已在创建 Goal 的原始回合 `01a14e10-940f-7902-8faf-f17462d4dcd1`、补充功能回合 `01a14e26-07af-7813-bba5-991792aefada`、诊断续跑回合 `01a14e40-4a35-7a60-9ec2-6c9207c77984` 以及当前回合 `01a14e48-d959-7a43-9277-0dc04cb6a9f6` 持续存在。前一回合产出了新根因证据，属于进展；当前复核没有发现可继续执行的修复入口，属于无进展，阻塞阈值已满足。

恢复推进的条件：可调用、受认证的 App 问题确认接口，或可修复上述状态协调逻辑的 App 源码/版本更新。届时仍须完成两端卡片关闭、唯一持久答案、断线重连及重复点击的实际验收。不得把单入口保护或离线诊断改称完整完成。
