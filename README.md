# Ax 面板

一个自用的 Linux 服务器管理面板。Node.js + Express，纯静态前端，零构建、零前端依赖，部署后用一个浏览器就能管服务器。

> 仓库中的域名、密钥、Token、名单、Logo 均已替换为占位符；原部署相关的私有内容没有包含在内。

## 功能

| 模块 | 说明 |
| --- | --- |
| 概览 | CPU / 内存 / 磁盘实时指标（WebSocket） |
| 站点管理 | 扫描 nginx vhost，探活、证书到期、维护模式、禁止访问 |
| 文件管理 | 浏览 / 上传 / 下载 / 重命名 / 删除 / 在线编辑（原子写） |
| 终端 | 基于 WebSocket 的 PTY 终端（node-pty 可选） |
| 日志 | pm2 日志与 nginx 日志查看 |
| 进程 / 服务 | 进程列表、pm2 服务启停与日志跳转 |
| 云盘 | 内置网盘：文件夹、上传、分享式下载，SQLite 存储 |
| 下载 | aria2 JSON-RPC 调度（可选） |
| 部署卡 | 发卡 + 设备锁，向客户端下发 Claude Code 安装脚本（可选） |
| 通知中心 | 站内通知 + Server酱 / ntfy / 手机 App 推送（可选） |
| 测速 | 浏览器端上下行测速 |
| 访问统计 | 增量解析 nginx access.log，按天聚合、归属地 |
| 抽奖 | 纯前端抽奖，名单在 `public/js/draw.js` |
| 虚拟女友 | 转发到外部 gf-bot 管理口（可选） |
| 设置 | 面板名、登录密钥、会话管理、雨云 API 等 |

## 环境要求

- Linux（主要按 Debian / Ubuntu 测试）
- Node.js >= 18（原生模块建议 Node 22）
- `better-sqlite3` 需要预编译包或本机编译工具链（`python3` / `make` / `g++`）
- nginx（站点管理、证书、访问统计依赖它）
- pm2（服务管理依赖它，可选）

## 快速开始

```bash
git clone https://github.com/YuMaxCat/Ax-Panel.git
cd ax-panel
npm install

cp config.example.json config.json
# 至少改 secretKey；sessionSecret 留空会在首次启动时自动生成并写回
node server.js
```

打开 `http://127.0.0.1:9906`，用 `config.json` 里的 `secretKey` 登录。首次启动后 `secretKey` 会被替换成 scrypt 指纹，建议登录后在「设置 → 登录密钥」里改成自己的强口令。

生产环境用 pm2：

```bash
pm2 start server.js --name ax-panel
pm2 save
```

### nginx 反向代理

终端和实时指标走 WebSocket，nginx 需要转发 Upgrade 头。`client_max_body_size` 要大于等于云盘/上传模块配置的值。

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name panel.example.com;

    ssl_certificate     /etc/nginx/ssl/panel.example.com.fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/panel.example.com.key;

    client_max_body_size 2g;

    location / {
        proxy_pass http://127.0.0.1:9906;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $connection_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
```

面板按 `CF-Connecting-IP → X-Real-IP → X-Forwarded-For` 取真实客户端 IP，登录限速和告警依赖它。

## 配置

完整字段见 `config.example.json`。几个容易踩的点：

- `secretKey`：首次可写明文，启动后自动转成 scrypt 指纹；也可用环境变量 `ADMIN_KEY` 覆盖。
- `sessionSecret`：留空自动生成并落盘。换掉会让所有已登录设备掉线。
- `decoy.salt` / `cc.salt`：留空自动生成一次并落盘。`cc.salt` 用于加密下发的部署配置，**发卡后不要更换**。
- `nginx.vhostDir` / `stateDir` / `bin` / `conf`：按自己的 nginx 安装路径修改；「禁止访问」会往 vhost 里注入 `include` 文件。
- `fileRoots`：文件管理允许访问的根目录白名单，建议按需收紧。
- `drive.maxUploadSize`：必须 ≤ nginx 的 `client_max_body_size`。
- 下载 / 云盘 / 访问统计 / 虚拟女友等模块关闭后不会出现在前端导航里（`/api/meta` 下发开关）。

可选依赖：

- `aria2c`（下载模块）：JSON-RPC 默认 `127.0.0.1:6800`，`rpcSecret` 与 aria2 配置保持一致。
- `ip2location` 服务（归属地）：默认 `127.0.0.1:9901/api/location`，查不到时静默跳过。
- `ntfy` 或 Server酱（告警外发）：在 `alert` 段填 endpoint / topic / SendKey。
- 雨云 API（`rainyun`）：只读查询云服务器与域名到期时间。
- gf-bot（虚拟女友模块）：外部服务，对不上时把 `gf.enabled` 设为 `false` 即可。

`node-pty` 在部分平台需要编译工具链；装不上只是终端模块不可用，其余功能不受影响。

## 目录结构

```
server.js            HTTP / WebSocket 入口
auth.js              Cookie 签名、登录密钥指纹
config.js            配置默认值、读写与环境变量覆盖
routes/              API 路由（认证、站点、文件、终端、云盘……）
lib/                 业务实现（nginx、pm2、探活、告警、证书、统计……）
public/              前端静态文件（index.html / login.html / js / css / vendor）
assets/              部署卡脚本模板与安装步骤
maint/               维护模式页面
tools/               辅助脚本
data/                运行时数据（自动生成，已被 .gitignore 忽略）
```

## 安全说明

面板本身可以执行 root 级操作（终端、文件管理、pm2、nginx），请务必：

1. 只在内网或 HTTPS + 强口令的前提下暴露；
2. 登录后立刻修改默认的 `change-me`；
3. 用 `fileRoots` 限制文件管理范围；
4. 不要把 `config.json`、`data/` 提交到仓库；
5. 面板后面必须由 nginx 等反向代理提供 TLS，不要直接监听公网。

## 第三方资源

- `public/vendor/xterm.js`、`public/vendor/addon-fit.js`：xterm.js 与其 Fit 插件，MIT。
- `public/vendor/china-map.js`：由公开地图数据生成的省级轮廓，使用前请自行确认数据许可。
- 仓库内的 Logo 为占位图。原项目使用过的个人插画 Logo 与第三方字体没有包含在仓库中。

## License

[MIT](LICENSE)
