# Changelog

## Codex Relay v1.0.3 - 2026-10-21

- Release 仅提供桌面端 ZIP 及其 SHA-256 校验文件。
- 中继部署改用 Source code 源码包，仍可在本地生成独立的中继 ZIP。

## Codex Relay v1.0.2 - 2026-10-21

- 仓库迁移至 `CaptainUnhappy/codex-web-relay`，更新下载、反馈与 CI 链接。
- 中继登录页新增桌面端下载与更新入口，始终指向最新 Release。
- 保留现有 CI/CD、历史版本 ZIP 和安装配置兼容性。

## Codex Relay v1.0.1 - 2026-10-21

- 简化首页、中继安装文档和 Release 说明，将来源与版权声明集中到 NOTICE。
- 桌面端、中继服务器 ZIP 及中继安装流程均携带 LICENSE 和 NOTICE。
- 更新受保护主分支的发布说明；消息收发功能保持不变。

## Codex Relay v1.0.0 - 2026-10-21

- 独立维护为 `CaptainUnhappy/codex-relay`，更新界面名称与安装文档，保留原项目署名和许可证。
- Windows、macOS、Ubuntu CI，以及隔离的 Chromium 浏览器回归。
- 版本标签自动发布桌面端与中继服务器 ZIP，并附 SHA-256 校验文件；公开包不含注册密钥。
- 更新 sharp 至 0.35.5，修复图像解码依赖漏洞，并加入生产依赖高危漏洞审计。
- 包含设备密钥切换、设备缓存隔离、同任务排队、提问卡片和移动端输入栏修复。

以下保留原项目发布历史。

## v4.5.2 - 2026-06-30

- Published Apple Silicon, Intel, Windows, and Android download assets for Codex Mini v4.5.2.
- Added project thread expand/collapse behavior so large project lists stay compact.
- Improved mobile settings organization, entry icons, status-display ordering, and status indicator animation.
- Fixed internal process summaries and handoff notes appearing in mobile replies.
- Fixed attachment cards being inserted into the middle of replies or misdetected from Markdown text.
- Fixed the Mac guardian screen so changing thread-card visibility refreshes immediately.

## v4.4.2 - 2026-06-20

- Published Apple Silicon, Intel, and Windows installers for Codex Mini v4.4.2.
- Added older-thread loading for the mobile thread list.
- Fixed SSH remote threads being hidden by local thread pagination.
- Published a cleaner Windows installer payload with runtime files only, excluding internal docs, packaging scripts, and build source.

## Unreleased

- Converted this branch into a local-only open-source edition.
- Removed hosted access, payment, activation, and test-build distribution code paths.
- Kept the core local phone-to-Codex bridge, thread list, send, status, model menu, and macOS wrapper app.
