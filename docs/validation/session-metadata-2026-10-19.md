# 额度、上下文与权限验证（2026-10-19）

## 结果

- 账户额度改用原生 `account/rateLimits/read`，优先 `rateLimitsByLimitId.codex`，订阅 `account/rateLimits/updated`；最多缓存 15 秒，点击可强制刷新。读取失败显示未知，不回退到某个对话的历史额度。
- 当前上下文使用 App 的计算式 `min(last.totalTokens, modelContextWindow) / modelContextWindow`。Mini 持有会话时接收原生 token usage 通知；观察桌面会话时读取该线程的最新 `token_count` 记录。缺少字段显示未知，不拼接不同事件的窗口和 tokens。
- 切换会话立即清空上下文与权限快照；历史请求、运行状态轮询和空闲轮询均拒绝过期响应，包括 A→B→A。账户额度按账户共享，不属于任一会话。
- 删除把当前上下文再次标为“对话用量”的控件，保留可点击切换显示方式的原上下文圆环。
- 权限菜单提供请求批准、帮我批准、完全访问、自定义配置。读取菜单不取得 writer；写入使用原生 `thread/settings/update`，遵守原生配置约束，对后续 turns 生效。桌面占用、拒绝、超时均不显示保存成功，也不自动重放。
- 原生 `thread_settings_applied` 记录用于恢复最新权限，优先于先前的 `turn_context`。全局 config.toml 没有修改。

## 一致性证据

安装包 `OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0` 中，`webview/assets/app-primary-19fe57fd8c00.js` 的 `GH` 函数使用上述上下文公式；`.vite/build/src-CP7XXlpZ.js` 权限目录将请求批准映射到 workspace/on-request/user，将帮我批准映射到自动审核，将完全访问映射到 danger-full-access/never/user。当前 CLI 使用 `auto_review`，并接受 App 使用的旧别名 `guardian_subagent`。

官方协议说明：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。实际 CLI 的权限约束方法为 `configRequirements/read`；权限 profile 通过 `permissionProfile/list` 核对，不依据菜单名称猜测参数。

2026-10-19 14:58（Asia/Taipei）只读并行核验：App 账户接口 `usedPercent=21`，Web 账户接口 `remainingPercent=79`，周期均为 10080 分钟，重置时间一致。随后真实 HTTPS 页面自动更新到 78%。

两个真实线程分别读到 `298089/475000`（62.76%）和 `115617/475000`（24.34%）；稍后页面分别显示约 63% 和 26%，对应各线程后续 token 更新。切换时观察到圆环立即变为未知，没有沿用前一线程的数值；打开权限菜单显示四种真实可用选项。检查完成后恢复原对话选择。

## 可复现检查

- `npm.cmd run check`：通过现有完整检查，包括后端、提问、消息、队列、列表、滚动、发布与启动脚本。
- `node scripts/test-codex-usage.js`：App 计算公式、零值/未知、压缩后变化、线程历史不提供账户额度、原生权限记录归属。
- `scripts/test-session-metadata-ui.js`：Playwright 隔离页面在 390×844 与 1280×800 下验证定时更新、手动刷新、1%、未知/恢复、切换立即清空、A→B→A 迟到响应、权限成功/失败、不重试、原圆环切换。
- `scripts/test-question-ui.js`：原提问卡片等回归通过，包含 320/390/1024 宽度。
- `node scripts/test-session-permissions-live.js`：独立临时 Codex home；四种权限实际写入并用原生 resume 回读一致，关闭 App Server 后恢复仍一致，只读记录解析一致。没有模型请求，没有改动正式线程或全局配置。

原生跨进程直接 settings 更新不能修改另一个客户端未加载的线程；因此编辑权限需要获得 writer。该限制没有被绕过。真实手机硬件未操作，手机布局通过浏览器触摸视口回归；正式 HTTPS 页面已只读核验。

## 同日补充：固定上下文控件

移除第三种仅圆环模式与手机端隐藏数值的规则。上下文复用额度的 32px 高胶囊样式，固定 78px 宽，圆环在左、数值在右，仅保留百分比与 token 数量两个模式。旧圆环偏好自动归入百分比，旧三态顺序不再参与切换。

`test-session-metadata-ui.js` 在 320、390、1280px 宽度各连续点击四次，验证控件外框、圆环、文本区及右侧模型按钮的坐标、尺寸、圆角完全不变；手机端数值始终可见。触发原缺陷的用例修改前失败，修改后通过。

正式 HTTPS 页面已点击核验 `72% → 341k → 72%`，均为 78×32px、999px 圆角，圆环始终在左。静态资源已热更新，无需重启中继。

## 同日补充：紧凑布局、额度倒计时与完整模型状态

- 在上述版本基础上，上下文进一步缩至 64×32px；额度复用同一布局，固定 76×32px，为 `23h 59m` 留足宽度。两者均采用 14px 圆环、左圈右值，切换时不改变外框、圆环、文本区域或相邻按钮的位置。
- 额度点击在剩余百分比与原生账户接口 `resetsAt` 的倒计时之间切换，同时保留强制刷新。倒计时复用现有 5 秒界面刷新，至少一天使用天/小时，不足一天使用小时/分钟，未知时间显示 `--`，已到重置时间不显示负数。显示偏好保存在本机。
- 模型按钮原先仅在已有思考等级时才改用横向布局，加载不完整时仍是网格，导致箭头换行。现统一横向布局，并由一个渲染函数同时更新模型与思考等级；任一未读到时隐藏按钮，完整后一起显示。箭头改为固定尺寸 SVG，垂直居中。

验证：

- `scripts/test-session-metadata-ui.js`：320/390/1280px 连续点击验证两种控件尺寸与相邻位置完全不变，倒计时无截断；覆盖 `5d 13h`、`3h 42m`、`23h 59m`、一天边界、过期和未知时间。分别模拟仅模型、仅强度、两者完整；完整后文字同行，箭头中心偏移小于 0.5px。原会话切换与权限回归继续通过。
- `scripts/test-question-ui.js`、`node scripts/test-ui-contract.js`、`node scripts/test-web-request-scheduling.js` 与 `git diff --check` 通过。
- 正式 HTTPS 页面点击核验 `73% → 5d 13h → 73%`；额度 76×32px、上下文 64×32px，点击前后位置相同，模型箭头中心偏移为 0px。完成后恢复百分比偏好并关闭临时测试标签。没有改模型、权限或发送消息；手机布局使用触摸视口验证。
- 截图：`output/playwright/context-pill-mobile.png`（隔离手机视口组件）和 `output/playwright/compact-metadata-live.png`（正式页面）。静态资源已热更新，本次无需重启服务。
