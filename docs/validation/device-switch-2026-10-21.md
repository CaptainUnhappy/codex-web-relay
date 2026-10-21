# 手机切换设备验证

日期：2026-10-21。目标：打开新设备密钥后切换设备，隔离旧设备的会话 ID 和缓存。

## 根因与改动

- URL 的 `#k` 不随 HTTP 请求发送。旧中继在 A 的 cookie 有效时直接代理 A，而密钥读取代码只在登录页运行。现在 Web 在恢复任何设备数据前处理初始密钥和 `hashchange`，进入中继配对页；离线页同样支持新链接。登录页自动接收密钥，串行提交，成功后清除 fragment。
- 旧 `codexMini.selectedThread` 是同一域名共用的全局键。现在先验证设备，再加载配置、恢复对话及读取历史；选中对话、聊天缓存、线路、项目展开、完成提醒、模型/强度覆盖及提问关闭状态均按设备隔离。旧无设备标记的选中 ID 只有被当前设备列出时才迁移，不直接向新设备查询它。
- 请求带预期设备 ID；中继和本地服务在转发或执行前拒绝不匹配设备。响应设备标识以及跨标签页设备变化触发重新连接，迟到响应不能继续恢复旧数据。此 ID 不是认证凭证，认证仍由既有 cookie/令牌完成。
- 新客户端遇到忽略 `?pair=1` 的旧中继时，通过既有退出/登录入口接收密钥，避免重定向循环。旧中继登录页仍需用户点击一次登录；全自动切换与跨设备请求拒绝需要更新中继。

## 复现与检查

`scripts/serve-device-switch-fixture.js` 启动生产中继代码与两台合成 WebSocket 桌面，不读取实际设备配置。`scripts/test-device-switch-ui.js` 在同一浏览器上下文中操作生产页面和实际中继 cookie。

- 修复前：已有 A 登录状态时打开 B 链接，仍显示 `A conversation 1`，新密钥切换断言失败。
- 修复后：首次链接登录、已有登录下的新链接、同页 hashchange、A→B→A 选中对话恢复通过。
- B 忽略旧全局 A 会话 ID，8 组设备状态键全部不同。
- 跨标签切换及迟到 A 历史响应不会覆盖 B 页面。
- cookie 已改为另一设备时，旧标签的写请求返回 `409 DEVICE_SESSION_CHANGED`，没有转发到桌面。
- 离线 A→B、无效密钥留在配对页、旧中继入口兼容通过。
- 所有模拟设备收到的外来 thread/session ID 为 0，业务 POST 为 0；测试登录仅针对合成设备。
- `npm.cmd run check`、既有额度/上下文、输入栏动作和提问卡片浏览器回归通过。

复跑：先执行 `node scripts/serve-device-switch-fixture.js`，再通过 Playwright `browser_run_code_unsafe` 的 filename 参数执行 `scripts/test-device-switch-ui.js`。测试使用本地 19088/19089；结束后停止 fixture 进程。截图：`output/playwright/device-switch-b-2026-10-21.png`。

## 交付边界

- 需要更新通用桌面 ZIP 和中继服务器 ZIP，并在对应设备及中继加载新版代码后才具备完整保护。
- 本次不在正式环境切换真实设备密钥，不发送正式会话消息；没有部署 VPS 或推送 Git。
- 代码提交后通知「修复 Codex Mini Relay 启动脚本」任务更新 ZIP；该持续协作约定记录在根目录 `AGENTS.md`。
