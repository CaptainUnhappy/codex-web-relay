# 自动任务消息导致待答卡消失：修复验收

2026-10-18 15:43 UTC。修正 `1e2d2f0` 中过于宽泛的旧提问清理条件。

## 真实原因

会话「恢复 Kazuya 并行模拟器监督」(`01a137c2-71a0-76f0-a3d4-ae5e9bf39117`) 中，问题 `call_fb93f36bdc9040dcb7dbb629398ed4e5` 于 14:52:29 UTC 创建。14:56:46 UTC 启动的后续轮次带有 `task_started.turn_attribution.turn_trigger = automation_heartbeat_scheduled`，其输入同样落盘为 canonical `UserMessage`。

旧清理规则只检查 `UserMessage` 类型，误把定时任务视为人工新指令并清空待答卡。真实回放和公网 `/codex/approvals` 均复现空列表。记录约 286 MB，但本题仍在最后 5 MiB 中；这次不是读取窗口截断或浏览器缓存问题。`{"accepted":true}` 只是提问工具接受了请求，不是用户回答。

## 修复

- 按 turn ID 关联实际 `task_started` 来源，仅明确来自 `composer` 的新用户指令可结束旧提问展示。
- 定时任务、其他自动来源、未知来源，以及截断后缺失来源的消息保留待答卡；不通过正文是否含有 heartbeat 字样猜测来源。
- 结构化回答仍按问题 ID 逐题确认，与轮次来源无关；部分回答保留其他问题。切换到缺失来源的新轮次不会沿用上一个轮次的 composer 来源。
- 本次不修改 App 会话、不代答、不操作问题中提及的应用或进程。

## 验证

| 检查 | 结果 |
| --- | --- |
| 新回归测试 | 修复前 `scheduled heartbeat UserMessages must not dismiss a pending App question` 失败（0 vs 1）；修复后通过 |
| 来源判定 | 自动消息不带 XML、人工消息含 heartbeat 字样、来源未知、轮次交错、来源截断、legacy user_message、部分回答、追加消息后 reader 缓存刷新均通过 |
| 真实记录回放 | 本题准确返回 1 张卡片和原来的两个选项；此前「修复 Codex Mini Relay 启动脚本」中过时的问题仍返回空列表 |
| 完整回归 | `npm.cmd run check` 通过；新增缓存断言后 `node scripts/test-user-input.js` 再次通过 |
| 当前公网页面 | 已恢复对应问题 ID 和两个选项，没有发送答案 |
| 独立手机/桌面上下文 | 390×844 手机模拟视口及 1280×900 桌面浏览器均显示同一问题和同样选项；断网、重连、刷新后仍保留；无横向溢出，写请求数均为 0 |

已查看截图：`output/playwright/question-heartbeat-restored-phone.png` 和 `output/playwright/question-heartbeat-restored-desktop.png`。手机验证使用浏览器设备模拟，不是操作用户实体手机。

## 生效与边界

在核验 Mini 无接管会话、无待发送队列和未确认操作后，仅重启其 Node 子进程，由原 supervisor 恢复。Codex App 和隔离原型均未重启或切换。

正式 Web 对 App 专属问题仍为只读展示；原生回答入口及统一提问原型的隔离边界不变。当前 reader 仍使用最后 5 MiB 的历史窗口，未在此修复中改造完整提问状态索引；App 撤回但未留下确认事件的状态也不能由历史推断。本次验证的是这张问题被自动消息误清除的回归。

未纳入原有打包脚本、证书恢复文档等其他工作区修改。
