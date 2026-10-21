# Codex Relay

[![CI](https://github.com/CaptainUnhappy/codex-web-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/CaptainUnhappy/codex-web-relay/actions/workflows/ci.yml)
[![Release](https://github.com/CaptainUnhappy/codex-web-relay/actions/workflows/release.yml/badge.svg)](https://github.com/CaptainUnhappy/codex-web-relay/releases)

用手机浏览器继续电脑上的 Codex 任务。Codex Relay 在电脑上连接 Codex App Server，通过自托管中继同步消息、图片、运行状态、队列与审批；Codex 账号和执行环境留在自己的电脑上。

本仓库独立维护，提供 Windows / macOS 桌面桥接程序和自托管中继服务器。

## 下载

从 [Releases](https://github.com/CaptainUnhappy/codex-web-relay/releases/latest) 下载：

| 附件 | 用途 |
| --- | --- |
| `codex-relay-desktop-universal.zip` | Windows / macOS 电脑上的桥接程序 |
| `SHA256SUMS` | 桌面端 ZIP 的 SHA-256 校验值 |

请下载具名桌面端 ZIP。GitHub 自动附加的 Source code 源码包可用于自托管中继，步骤见[中继部署说明](relay-server/README.md)。公开 ZIP 不包含注册密钥、设备状态、登录凭据或预置公共中继服务，需要配置自己的中继地址。

## 快速开始

需要一台已安装并登录 Codex 的 Windows / macOS 电脑、支持 `app-server` 的 Codex CLI，以及可访问的中继服务器。建议使用 Node.js 24 LTS。

### 1. 准备中继

按[中继部署说明](relay-server/README.md)安装服务，配置 HTTPS / WSS、管理员密码和 `CODEX_MINI_RELAY_REGISTRATION_KEY`。记下公共地址与注册密钥。

### 2. 启动桌面端

解压桌面 ZIP 到可写目录，保留整个目录结构。

**Windows**：将 `desktop-env.example.ps1` 复制为 `desktop-env.local.ps1`，填写自己的配置：

```powershell
$env:CODEX_MINI_RELAY_PUBLIC_BASE = 'https://relay.example.com/codex'
$env:CODEX_MINI_RELAY_REGISTRATION_KEY = '填写服务端配置的注册密钥'
```

双击 `start-codex-relay.bat`。启动脚本会检查运行依赖；Windows 默认只检查 CLI 版本和 App Server 支持，每项最多等待 8 秒，不会在默认启动检查中发送模型测试消息。

**macOS**：将 `desktop-env.example.sh` 复制为 `desktop-env.local.sh`，填写：

```bash
export CODEX_MINI_RELAY_PUBLIC_BASE='https://relay.example.com/codex'
export CODEX_MINI_RELAY_REGISTRATION_KEY='填写服务端配置的注册密钥'
```

然后在终端运行：

```bash
bash start-codex-relay.command
```

首次注册后，进入中继 `/admin/` 页面批准该设备。桌面端将显示手机访问链接和二维码，保持启动进程运行。

注册密钥用于申请设备，手机链接中的设备密钥用于访问该设备，两者不要混用。为兼容已有安装，环境变量仍使用 `CODEX_MINI_*`，旧启动文件名仍可使用。

### 3. 手机连接

扫码或打开桌面端提供的链接，也可以将网页添加到手机主屏幕。打开另一台设备的新链接时，会先完成设备配对，再恢复该设备的任务与缓存；旧标签页不能借用另一台设备的登录状态发送请求。

## 日常使用

- 项目和无项目对话分别分页；每个对话先加载最近 5 条消息，可按需读取更早记录。
- 支持文字、图片、运行进度、模型与思考等级、账户额度和上下文用量。
- 桌面端占用同一任务时，新消息保留在原生队列中，每隔约 15 秒检查，获得写入权限后按顺序继续。停止回复不一定会释放任务占用。
- 同时最多接管一个任务，默认在回复结束且空闲 1 分钟后归还；可手动释放。结果不明的操作会暂停，需核对记录后继续，避免重复发送。
- Codex App 发起的异步问题仍需在 App 中回答；手机显示问题并同步结果。Relay 自己收到的原生提问和审批可在网页处理。
- 锁屏和亮屏均通过 App Server 工作；电脑必须保持运行、联网，不能进入会中断服务的睡眠状态。

## 更新与排错

更新前备份 `desktop-env.local.ps1` / `desktop-env.local.sh` 和设备状态，停止桌面桥接进程，再解压新版。不要删除 Windows `%APPDATA%\CodexMini` 或 macOS `~/Library/Application Support/CodexMini` 下的设备文件。新版继续兼容这些状态目录。

涉及配对和设备隔离的升级，需要桌面端与中继同时加载新版。中继更新步骤见[部署说明](relay-server/README.md#更新已有部署)。

启动日志位于解压目录的 `logs/`。无法发送时，先确认中继连接、设备审批状态、CLI 路径及登录状态。若显示等待桌面端释放，先在桌面端释放该任务；不要重复提交相同消息。

可在项目目录安装独立 CLI：

```powershell
npm.cmd install --prefix .runtime/codex-cli-bin --no-save --no-package-lock @openai/codex@latest
```

Windows 完整发送诊断需要显式设置 `CODEX_MINI_FULL_CODEX_CLI_CHECK=1`，它会发送测试消息。macOS 启动器仍保留完整检查，可设置 `CODEX_MINI_SKIP_CODEX_CLI_TEST=1` 跳过该发送测试。

## 开发与发布

```bash
npm ci
npm run check
npx playwright install chromium
npm run test:browser
npm run package:release
```

`check` 运行离线合同测试、打包回归，以及当前平台的启动脚本检查。浏览器回归启动临时静态服务和合成设备，不读取用户设备注册表或调用真实模型。公开发布产物生成在 `dist/`。

CI 对分支推送与 PR 执行 Windows、macOS、Ubuntu 检查，并运行 Chromium 浏览器回归。全部通过后，Actions 提供 ZIP 构建产物。

发布步骤：更新 `package.json` / `package-lock.json` 的版本和 `CHANGELOG.md`，在分支通过 CI 后合并到受保护的 `main`，再推送匹配版本的标签（例如 `v1.0.3`）。Release 工作流重新检查该标签，构建并核验桌面端 ZIP，再发布 ZIP 和 `SHA256SUMS`。标签必须位于 `main` 历史中且与包版本一致。已发布版本不覆盖，请使用新版本号。

CI 不需要中继密钥。发布流程只交付桌面端 ZIP，不自动部署 VPS，也不会改动现有设备状态。需要单独的中继部署包时，可在本地运行 `npm run package:server`。私下制作预配置桌面包时，仍可使用 `scripts/package-release.py desktop --env-file <本机配置文件>`；这类包不得作为公开 Release 附件。

## 反馈与授权

问题与建议请提交到 [Issues](https://github.com/CaptainUnhappy/codex-web-relay/issues)，并附系统版本、复现步骤和已脱敏日志。

使用条款见 [LICENSE](LICENSE)，来源与版权声明见 [NOTICE](NOTICE)。历史文档及旧 macOS 包装工程仅作参考；当前分发与安装以本 README 和 Releases 为准。
