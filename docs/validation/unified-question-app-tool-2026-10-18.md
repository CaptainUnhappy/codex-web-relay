# 统一提问工具接入 App：真实隔离验收

日期：2026-10-18（Asia/Taipei）。分支：`codex/unified-question-prototype`。

## 结论

真实 Codex App 测试对话成功调用项目级 MCP `unified_question_isolated.ask_question`。手机触摸模拟页面提交一次回答后，Codex App 内浏览器中的独立提问卡片同步收起输入和发送控件。模型取得答案和收据，给出正确回显。

随后通过真实 Codex 再次调用同一个工具、同一个问题，服务返回 `already_claimed` 且不含 `value`。模型输出 `DUPLICATE_RESULT_SUPPRESSED`。原始模型可见工具输出中，新增答案正文恰好一次；数据库是一条答案、一条领取记录。

**边界：手机仍是 Chromium 移动视口/触摸模拟；桌面卡片在真实 Codex App 的浏览器面板中，保持现有样式，但不是原来的原生 `request_user_input_async` 卡片。没有切换正式 Mini 或中继服务。**

## 真实证据

- 测试对话：`Web 提问交互端到端测试`，ID `01a14dcb-3bf7-7c60-9e10-ebb350f80a24`。
- 成功 turn：`01a14f15-a431-7572-9d16-46c4ddd28cdf`。
- 重复验证 turn：`01a14f1a-f3cf-75b0-ae65-2432c9d90e69`。
- 问题：`app-question-806abb56-924d-4a31-b5bc-2df5b731d8d0`。
- 收据：`43002e51-10f1-4266-b5e2-aa84887d7ff7`。
- 数据目录：`output/question-prototype/PROTOTYPE-gbmp7V`，与正式数据独立。

模型的实际回显：

```text
REAL_UNIFIED_QUESTION_OK：手机真实验收 Q7M4 <beta>
第二行：只接收一次
RECEIPT：43002e51-10f1-4266-b5e2-aa84887d7ff7
```

[机器可读审计结果](unified-question-app-tool-evidence-2026-10-18.json) 由 `audit-app-run.js` 从原始 rollout、MCP trace 和 SQLite 计算生成：

| 检查 | 实际结果 |
| --- | --- |
| 模型可见的含答案工具结果 | 1 |
| 真实重复调用的无答案拒绝结果 | 1，`already_claimed`，无 `value` |
| MCP `answer_emitted` | 1 |
| 持久答案 / 领取记录 | 1 / 1 |
| 手机 UI 正常提交 | 1 个 POST |
| 相同提交编号重试 | 返回原收据，版本不增加 |
| 新编号重复提交 | HTTP 409，未覆盖答案 |
| 手机断线、重连、刷新 | 保持已答，revision 2 |
| App 内卡片刷新 | 仍显示“已在手机端回答”，没有输入/发送控件 |

原始 rollout 位于 `C:/Users/Unhappy/.codex/sessions/2026/10/18/rollout-2026-10-18T14-55-27-01a14dcb-3bf7-7c60-9e10-ebb350f80a24.jsonl`。第 223 行是 MCP 完成事件，第 224 行是同一事件的模型可见输出；第 229 行是模型最终回显。第 271/273 行对应重复调用及无答案结果。审计区分 `event_msg` 和 `response_item` 两种投影，没有把同一事件的多份日志当成多次回答。

该证据说明答案作为新工具结果只投递一次。后续模型请求正常携带历史上下文，不属于新的答案投递；没有代理或记录 OpenAI 的底层认证请求。

## 可见界面

手机模拟页面实操选项/自定义输入/发送，通过真实 HTTP 服务提交；随后用 CUA 读取 App 内浏览器的可访问性树，确认回答控件消失。截图：

- [手机提交前](../../output/playwright/question-app-real-phone-before.png)
- [手机提交后](../../output/playwright/question-app-real-phone-after.png)
- [App 内卡片已答](../../output/playwright/question-app-real-desktop-after.jpg)

页面沿用上一阶段的现有卡片样式，本阶段没有改动 CSS 或卡片渲染。

## 接入与去重设计

新增 `mcp.js` 将原型的创建/等待/领取流程暴露为 stdio MCP 工具。问题 ID 和会话 ID 固定在本次测试的绑定文件，模型不能通过工具参数更换 ID 来绕过去重。

服务端增加 `deliveries.question_id` 唯一记录。答案保存和工具投递是两个独立的确认边界：浏览器只能回答，不能领取工具结果；工具凭据只允许读取/创建/领取绑定的问题，不能代替用户回答或读取其他问题。相同问题的第二次工具调用只能取得状态和收据，不能再次取得答案正文。

领取记录在输出前落盘，优先保证不重复投递。若领取成功后响应丢失或进程退出，结果属于 `delivery_uncertain`；后续调用不会盲目重放答案。**这不是同时保证“绝不重复”和“任何崩溃后自动送达”的 exactly-once 系统**；恢复此类不确定投递需要核对原调用记录，本阶段没有提供自动恢复按钮。

普通问答只调用一次；显式授权的重复调用验收允许再次请求。初版工具说明过于绝对，测试模型因此拒绝刻意重试；更新说明并重新初始化测试线程后，实际重复调用已执行并得到服务端拒绝，不把模型拒绝调用当作去重通过。

## 回归与审查

`npm.cmd run prototype:questions:check` 通过，保留上一阶段的 20 请求竞争、跨进程写入、事务失败与重启恢复校验。

`npm.cmd run prototype:questions:mcp-check` 通过，覆盖：

- 真实 stdio initialize / tools/list / tools/call。
- 两个并发工具调用只取得一份答案正文，只有一个可见问题和一条领取记录。
- 同一个 pending JSON-RPC ID 不重复处理，完成后的 ID 可以合法复用。
- 显式 null ID、空白问题、非法选项、过多选项与多余字段被拒绝。
- 工具凭据不能自己回答，也不能访问其他问题；浏览器凭据不能领取结果。
- 重复工具调用及 MCP 进程重启后不重放答案。
- 真实 HTTP 代理丢弃领取成功的响应：返回 `delivery_uncertain`，MCP 重启后仍不再次返回答案正文。

独立审查核对了原始 App 证据，并促成上述请求编号、输入边界、工具权限和不确定投递处理。审查对“并发调用会创建重复卡片”的推测未被证据支持：稳定问题 ID 的唯一约束已保证只创建一题，新增并发 MCP 测试进一步验证了这一点。

真实 App 验收之后加入的权限和协议边界加固由上述实际 stdio/HTTP 回归验证；没有把这些故障注入描述成真实模型故障测试。

## 配置还原与隔离

根据 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp)，项目 MCP 配置仅在可信项目中加载。本次只在专用测试目录创建 `.codex/config.toml`，并临时信任该目录。旧对话不会自动刷新已加载的工具列表，通过 App 会话管理接口归档/恢复该测试对话后，实际加载成功；未重启整个 App 或正式服务。

验收后精确删除本轮创建且哈希未变化的测试配置，撤销临时信任，并重新打开测试对话以卸载临时工具。全局配置 SHA-256 恢复为：

```text
D5E7B0DC5B644048B87BDA18E89E35DAD3FDB7DA77B7231160EAD256B3A0DF30
```

注册与撤销均未更改全局 MCP 列表。保留 18792 端口的独立结果预览；原 8787 Web 和公网中继保持原配置。没有推送代码。

## 后续计划，尚未启动

若要继续，下一阶段应把一次性测试绑定推广为真实会话/工具调用的稳定 ID 映射，补上等待超时、主动取消及不确定投递核对的用户交互，再接入受信 HTTPS 的独立测试入口，用实体手机验收。满足这些条件后，再另行决定是否切换正式服务。

现有原生异步卡片仍走原来的 App 单入口保护；本次验证的是替代工具链路，不自动更换其他对话的提问方式。
