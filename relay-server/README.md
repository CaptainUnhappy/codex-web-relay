# Codex Relay 中继服务器

自托管 HTTP / WebSocket 中继，将手机请求转发给已配对的电脑。任务执行与 Codex 登录状态留在电脑端。

本项目基于 **Codex Mini by [CoimgRain](https://github.com/CoimgRain/Codex-Mini)**，遵守随包提供的[非商业使用许可证](../LICENSE)。

## 全新安装

准备 Ubuntu / Debian、Node.js 24 LTS，以及可以配置 HTTPS / WSS 反向代理的域名。下载并解压 [Releases](https://github.com/CaptainUnhappy/codex-relay/releases/latest) 中的 `codex-relay-server.zip`，在解压目录运行：

```bash
sudo bash relay-server/install-systemd.sh
```

默认安装路径为 `/opt/codex-mini-relay`，服务名为 `codex-mini-relay`，配置文件为 `/etc/codex-mini-relay.env`。这些名称保持兼容已有部署。初次安装会生成管理员密码并在终端显示，请保存它。

生成注册密钥：

```bash
openssl rand -hex 32
sudoedit /etc/codex-mini-relay.env
```

将生成的值加入配置文件：

```dotenv
CODEX_MINI_RELAY_REGISTRATION_KEY=填写新生成的注册密钥
```

保留安装器生成的 `ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET` 和 `CODEX_MINI_RELAY_DEVICES`。配置文件应只有管理员可读，然后重启：

```bash
sudo chmod 600 /etc/codex-mini-relay.env
sudo systemctl restart codex-mini-relay
sudo systemctl status codex-mini-relay
curl http://127.0.0.1:8788/health
```

默认端口为 `8788`。可用 Nginx 将 `https://relay.example.com/codex/` 转发至本机端口：

```nginx
location /codex/ {
    proxy_pass http://127.0.0.1:8788/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
    client_max_body_size 20m;
}
```

此片段放在已经配置有效 TLS 证书的 `server` 中。将后端端口限制为反向代理可访问，手机和电脑使用 HTTPS / WSS 公共地址。

## 连接电脑

桌面端配置相同的 `CODEX_MINI_RELAY_PUBLIC_BASE` 和 `CODEX_MINI_RELAY_REGISTRATION_KEY` 后启动。进入公共地址下的 `/admin/`，使用管理员密码登录并批准新设备。桌面端批准成功后会生成手机链接。

注册密钥、管理员密码和每台设备的手机访问密钥用途不同，不要将它们放进公开仓库、日志或 Release 附件。

## 更新已有部署

先备份 `/etc/codex-mini-relay.env` 和 `/opt/codex-mini-relay/relay-server/devices.json`。将新版 ZIP 解压到另一个目录，在该目录运行以下命令；安装路径有改动时请相应调整。

```bash
sudo systemctl stop codex-mini-relay
sudo rsync -a --exclude=devices.json --exclude=devices.json.bak relay-server/ /opt/codex-mini-relay/relay-server/
sudo cp package.json package-lock.json LICENSE /opt/codex-mini-relay/
cd /opt/codex-mini-relay
sudo npm ci --omit=dev
sudo chown -R codex-mini-relay:codex-mini-relay /opt/codex-mini-relay
sudo systemctl start codex-mini-relay
curl http://127.0.0.1:8788/health
```

现有安装器用于全新安装，会替换服务目录；更新已有部署请使用上面的保留设备文件流程。配对、会话隔离等联动升级，需要同时更新电脑端。

## 日志与配置

```bash
sudo journalctl -u codex-mini-relay -f
```

| 配置 | 用途 |
| --- | --- |
| `PORT` | 服务监听端口，默认 `8788` |
| `CODEX_MINI_RELAY_REGISTRATION_KEY` | 桌面端申请注册的密钥 |
| `ADMIN_PASSWORD` | 管理页面密码 |
| `ADMIN_SESSION_SECRET` | 管理会话签名密钥 |
| `CODEX_MINI_RELAY_DEVICES` | 设备注册表路径 |

GitHub Actions 生成并校验中继 ZIP；发布 Release 不会自动部署或重启此服务。
