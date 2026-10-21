## 下载

- `codex-relay-desktop-universal.zip`：Windows / macOS 桌面桥接程序。
- `codex-relay-server.zip`：自托管 HTTP / WebSocket 中继服务器。
- `SHA256SUMS`：两个 ZIP 的 SHA-256 校验值。

请下载上述 ZIP；GitHub 自动生成的 Source code 附件是源码快照。

首次启动桌面端前，将 `desktop-env.example.ps1`（Windows）或 `desktop-env.example.sh`（macOS）复制为对应的 `desktop-env.local` 文件，并填写自己的中继地址和注册密钥。公开包不包含任何预置中继密钥。

升级前保留本机配置与设备状态。设备切换保护需要桌面端与中继服务器同时更新。发布 ZIP 不会自动重启或部署你的服务器。

安装、更新和自托管步骤见仓库 README。Codex Relay 基于 Codex Mini by CoimgRain，继续遵守随包提供的非商业使用许可证。
