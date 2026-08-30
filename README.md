# xub2api-
sub2api 抽奖插件：充值资格校验、加权抽奖、兑换码发放与合并、状态过滤及审计记录。
# 抽奖插件安装教程
https://eap.jindunlianghua.cn/   最低倍率0.1 不定时还有0.05倍率
<img width="552" height="329" alt="image" src="https://github.com/user-attachments/assets/61f5ef54-ff8f-45bd-8a9b-537592d546b4" />
<img width="1355" height="781" alt="image" src="https://github.com/user-attachments/assets/2ae6bfc3-4e1b-4b77-9a15-af108aeae87b" />

## 1. 软件要求

- Linux 主机，Node.js 18 或更高版本
- 已运行的 sub2api 服务
- 可访问 sub2api Admin API 的管理员 API Key
- sub2api 的 JWT 配置文件路径

本插件会校验 sub2api 签发的 access JWT，并使用管理员 API Key生成、查询和清理兑换码。管理员 API Key只保存在服务器本地文件中，不应提交到代码仓库或放入前端目录。

## 2. 解压插件

将 `lucky-draw-plugin.tar.gz` 上传到目标服务器，例如：

```bash
mkdir -p /www/lucky-draw
 tar -xzf lucky-draw-plugin.tar.gz -C /www/lucky-draw --strip-components=1
cd /www/lucky-draw
```

安装依赖：

```bash
npm ci --omit=dev
```

## 3. 配置密钥和路径

复制配置模板：

```bash
cp config.json.example config.json
```

编辑 `config.json`，至少修改：

- `sub2apiBase`：sub2api Admin API 地址
- `sub2apiConfigPath`：sub2api 的 `config.yaml` 路径，用于读取 JWT secret
- `adminKeyPath`：管理员 API Key 文件路径
- `port`：插件监听端口，默认 `3001`

创建管理员 API Key 文件。请由管理员通过安全方式写入真实 Key，并限制权限：

```bash
install -o root -g root -m 600 /secure/location/sub2api-admin-key /www/lucky-draw/sub2api-admin-key
```

然后将 `config.json` 的 `adminKeyPath` 设置为 `/www/lucky-draw/sub2api-admin-key`。不要把真实 Key 写入 `config.json`、网页、压缩包或日志。

## 4. 初始化数据目录

```bash
mkdir -p data
chown -R www:www /www/lucky-draw
chmod 750 /www/lucky-draw
chmod 750 /www/lucky-draw/data
chmod 640 /www/lucky-draw/config.json
chmod 600 /www/lucky-draw/sub2api-admin-key
```

如果管理员 Key 文件需要由 root 保管，请按实际运行用户调整读取权限；插件运行用户必须能读取 Key、JWT 配置文件，并能写入 `data/records.json` 和 `data/audit.log`。

## 5. 启动方式

### 临时启动

```bash
npm start
```

### 宝塔 Supervisor

在宝塔 Supervisor 管理器中新增项目：

- 项目名称：`lucky-draw`
- 运行目录：`/www/lucky-draw`
- 启动命令：`/usr/bin/node /www/lucky-draw/server.js`
- 运行用户：选择能读取配置和写入 `data` 的低权限用户
- 监听端口：`3001`

不要同时用 `npm start` 和 Supervisor 启动，否则会出现 `EADDRINUSE` 端口占用。

## 6. 接入前端反向代理

插件只监听 `127.0.0.1`。由现有网站或 Nginx 将前端请求代理到：

```text
http://127.0.0.1:3001/lucky-api/
```

前端请求状态接口时必须携带 sub2api 登录后取得的 access JWT：

```text
Authorization: Bearer <access-token>
```

不要把管理员 API Key放在浏览器或前端 JavaScript 中。

## 7. 验证安装

健康检查：

```bash
curl -fsS http://127.0.0.1:3001/lucky-api/health
```

预期返回包含：

```json
{"ok":true}
```

未登录访问状态接口应返回 `401`，这是正常的鉴权行为：

```bash
curl -i http://127.0.0.1:3001/lucky-api/status
```

使用真实用户 access JWT 后，再通过前端或受控命令调用状态接口。`mergedRewards` 只返回 sub2api 中仍为 `unused` 的合并兑换码；已兑换的码会从该列表消失，但 `data/records.json` 中的抽奖历史和 `data/audit.log` 中的审计记录会保留。

## 8. 安全检查

发布或转移安装包前检查：

```bash
tar -tzf lucky-draw-plugin.tar.gz
```

确认压缩包中没有：

- `data/records.json`
- `data/audit.log`
- 任何 `*.key`、`*.pem`、`*.secret` 文件
- 真实 `config.json`
- `node_modules`
- sub2api 的 `config.yaml`

升级时先备份目标实例的 `data` 目录，再替换代码文件；不要覆盖现网数据文件。
