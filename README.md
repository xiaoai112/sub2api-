# 抽奖中心与中奖播报安装教程

本包包含两部分：抽奖服务端和登录后中奖播报前端脚本。服务端只监听 `127.0.0.1`，由 Nginx 代理给网站使用。

<img width="1555" height="807" alt="image" src="https://github.com/user-attachments/assets/3c32106e-62a4-435e-8c16-0f05c26ca1a2" />



<img width="1662" height="285" alt="image" src="https://github.com/user-attachments/assets/f86a317a-bf39-445b-94e6-d36ab6b7c7c8" />



## 一、包含内容

- `server.js`：抽奖 API 服务
- `package.json`、`package-lock.json`：Node.js 依赖清单
- `config.json.example`：脱敏配置模板
- `lucky-win-broadcast.js`：登录后的中奖播报脚本

安装包不包含真实 `config.json`、管理员 API Key、JWT 密钥、抽奖记录、审计日志和 `node_modules`。

## 二、环境要求

- Linux 主机
- Node.js 18 或更高版本
- 已运行的 Sub2API 服务
- 可访问 Sub2API Admin API 的管理员 API Key
- 能读取 Sub2API `config.yaml` 中 JWT secret 的服务运行用户

## 三、安装服务

将 `lucky-draw-plugin.tar.gz` 上传到服务器并解压：

```bash
mkdir -p /www/lucky-draw
tar -xzf lucky-draw-plugin.tar.gz -C /www/lucky-draw --strip-components=1
cd /www/lucky-draw
npm ci --omit=dev
cp config.json.example config.json
```

编辑 `config.json`，至少确认以下配置：

- `sub2apiBase`：Sub2API 服务地址，例如 `http://127.0.0.1:8080`
- `sub2apiConfigPath`：Sub2API 的 `config.yaml` 绝对路径
- `adminKeyPath`：服务器上管理员 API Key 文件的绝对路径
- `port`：服务端口，默认 `3001`
- `timezoneOffsetHours`：业务时区偏移，东八区为 `8`

管理员 API Key 必须通过安全方式写入，不要放进网页、前端脚本、压缩包或日志：

```bash
install -o root -g root -m 600 /secure/location/sub2api-admin-key /www/lucky-draw/sub2api-admin-key
```

然后将 `adminKeyPath` 设置为 `/www/lucky-draw/sub2api-admin-key`。

初始化数据目录并设置权限：

```bash
mkdir -p /www/lucky-draw/data
chown -R www:www /www/lucky-draw
chmod 750 /www/lucky-draw
chmod 750 /www/lucky-draw/data
chmod 640 /www/lucky-draw/config.json
chmod 600 /www/lucky-draw/sub2api-admin-key
```

运行用户必须能够读取管理员 API Key 和 Sub2API JWT 配置，并能够写入 `data/records.json`、`data/audit.log`。

## 四、使用 systemd 启动

创建 `/etc/systemd/system/lucky-draw.service`：

```ini
[Unit]
Description=Sub2API Lucky Draw Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/www/lucky-draw
ExecStart=/usr/bin/node /www/lucky-draw/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/www/lucky-draw/data

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
systemctl daemon-reload
systemctl enable --now lucky-draw
systemctl status lucky-draw --no-pager
```

查看日志：

```bash
journalctl -u lucky-draw -n 100 --no-pager
```

不要同时使用 `npm start` 和 systemd 启动，否则会出现 `EADDRINUSE` 端口占用。

## 五、配置 Nginx 反向代理

在目标站点的 Nginx `server` 配置中加入：

```nginx
location ^~ /lucky-api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 10s;
    proxy_send_timeout 30s;
    proxy_read_timeout 30s;
    add_header Cache-Control "no-store, no-cache, must-revalidate";
    add_header X-Content-Type-Options "nosniff";
}
```

检查并重新加载 Nginx：

```bash
nginx -t
nginx -s reload
```

## 六、接入中奖播报

将 `lucky-win-broadcast.js` 放入网站静态目录，例如：

```text
/www/wwwroot/example.com/static/lucky-win-broadcast.js
```

在需要显示播报的页面 HTML `</head>` 前加入：

```html
<script src="/static/lucky-win-broadcast.js" defer></script>
```

脚本会从浏览器的 `localStorage.auth_token` 读取登录后的 Sub2API JWT，并请求：

```text
GET /lucky-api/admin/win-broadcast
Authorization: Bearer <access-token>
```

不要把管理员 API Key 写入前端。

如需按路由隐藏播报，应在 `isHiddenRoute()` 中加入对应路径，并通过查询参数更新脚本缓存版本。

## 七、验证

服务健康检查：

```bash
curl -fsS http://127.0.0.1:3001/lucky-api/health
```

预期返回成功 JSON，例如：

```json
{"ok":true}
```

未携带 JWT 访问用户状态接口返回 `401` 属于正常鉴权行为：

```bash
curl -i http://127.0.0.1:3001/lucky-api/status
```

确认网站接口代理：

```bash
curl -k -i https://example.com/lucky-api/health
```

## 八、安全和升级

发布或转移安装包前确认不包含：

- `config.json`
- `data/records.json`
- `data/audit.log`
- `*.key`、`*.pem`、`*.secret`
- Sub2API `config.yaml`
- `node_modules`

升级前先备份 `/www/lucky-draw/data`，再替换代码文件。不要覆盖现网数据文件和真实配置文件。

回滚 Nginx 接入时，删除对应的 `/lucky-api/` 代理配置，执行 `nginx -t` 后再平滑重载；回滚服务代码前应保留现网目录备份。
