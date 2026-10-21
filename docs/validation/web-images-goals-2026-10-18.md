# Web 图片预览与 Goal 验证

日期：2026-10-18。只提交本地，不推送。沿用现有深色界面，手机优先。

## 行为

- 点击已发送、历史记录或待上传图片打开全屏预览；支持双指缩放、放大后单指平移、缩放按钮、还原、关闭与 Escape，关闭后恢复焦点，保留发送草稿及附件。
- 图片依旧由原文件提供；历史接口把实际附件登记为受限的内存 ID，图片接口要求认证，不接受浏览器传入任意文件路径。不向 localStorage 写入大图片 data URL 或认证参数。
- Goal 显示于标题下一行：状态、目标摘要、实际累计用时。点击目标内容可查看全文和修改，右侧暂停/继续、清除；清除前确认并保留聊天。
- Goal 使用原生 `thread/goal/get`、`thread/goal/set`、`thread/goal/clear`，用户动作携带 `origin: user`。未调用 `thread/resume`、`turn/start` 或 `turn/interrupt`。
- 读取合入现有状态轮询，切换线程清空旧状态，过时读取不得覆盖新操作结果；写入前检查当前目标身份，网络回执丢失时只读回查，不自动重放写入。

## 根因

此前前端只有缩略图，没有查看器；历史附件只显示名称，也没有认证图片接口。全局触摸锁还会吞掉单指手势。

此前 backend 的 status/bootstrap 根本没有读取 Goal，前端无法显示 App 已有目标。当前实际 Mini CLI 版本 `0.159.0` 已支持 Goal 三种 RPC；App 同版本 schema 另有用户动作来源字段 `origin`。

## 验证结果

1. `npm.cmd run check` 全部通过，含新增 `test-thread-images.js` 与 backend Goal 用例。覆盖身份检查、拒绝任意路径/UNC/SVG/非图片、大小限制、文件缺失、读失败、目标变更冲突、未知结果不自动重试，以及现有队列、提问、滚动、缓存、启动、打包检查。
2. `scripts/test-goal-image-ui.js` 使用生产 HTML 和隔离 fixture API，通过真实 Chromium touch 事件测试双指 250% → 125%、单指平移、关闭/Escape、焦点恢复；覆盖待上传图片和输入草稿保留、横屏关闭按钮、390 px 与 1280 px 布局、长标题不挤出第二行。
3. 同一浏览器测试覆盖 Goal 编辑保留换行、失败保留草稿、暂停/继续、刷新恢复、切线程隔离、取消/确认清除、已保存但回执丢失后的只读确认，以及过时状态响应保护。无页面 JS 错误。
4. 公网中继真实 E2E：在已有隔离对话 `01a14dcb-3bf7-7c60-9e10-ebb350f80a24` 创建暂停的测试 Goal，经 Web 编辑、继续、暂停、刷新后确认；使用 Codex App 的当前二进制另开原生连接只读回查，目标全文及 paused 状态一致。最终从 Web 清除，并再次原生回查 `goal: null`。没有发起模型回复。
5. 主对话当前 active Goal 在手机尺寸 Web 正确显示，未修改该 Goal。真实历史图片原尺寸 1510×551，经公网读取并双指放大到 225%，可关闭。Mini 的 `ownedThreadId` 始终为空，`uncertainOperations` 为 0。
6. 本地未认证访问图片/Goal 接口均返回 401；公网未登录访问返回登录 HTML，不返回图片或 Goal 数据。
7. 独立审查指出“写成功但回执丢失仍显示失败”，已修复并加入浏览器回归。其余审查未发现可确认阻塞缺陷。

## 证据文件

- `output/playwright/goal-live-final-mobile.png`：真实主对话的 Goal，标题与操作在同一行，头部共 89 px。
- `output/playwright/image-live-pinch-mobile.png`：真实历史图片 225% 预览。
- `output/playwright/goal-strip-mobile.png`、`goal-strip-desktop.png`：隔离界面测试。
- `output/playwright/image-pinch-mobile.png`：双指缩放和平移测试。
- `scripts/test-goal-image-ui.js`：可通过 Playwright `browser_run_code_unsafe` 的 filename 参数执行；需 Mini 本地服务运行。

## 验证边界

- 浏览器测试为桌面 Chromium 的手机触摸模拟，未在实体 iPhone/Android 逐机验收。
- 原图片被系统清理后无法恢复；页面显示无法加载。服务重启后旧图片 ID 失效，重新加载聊天记录取得新 ID。不额外复制和长期存储用户图片。
- 已验证原生 Goal 数据的跨连接一致性；未验证正在打开的 Codex App 界面在另一独立服务修改 Goal 后立即刷新。App 有 Goal 更新通知处理代码，但不能将这等同于跨进程广播已通过。
- 原有桌面异步提问的 Web 直接回答入口仍保持禁用；App 单入口人工验收已收到用户确认，详见 `desktop-question-single-entry-2026-10-18.md`。
