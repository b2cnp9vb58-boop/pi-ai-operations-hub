# 部署说明

## 前置条件

- 由你自己管理的 Raspberry Pi OS 或 Debian 系 Linux 主机。
- Node.js 24+ 与 Python 3.12+。
- 在本仓库外配置好的 Claude 兼容 CLI 或提供方。
- 通过 BotFather 创建的 Telegram 机器人，并限制为私聊使用。
- 若要启用微信只读入口，还需要对应的微信提供方账号。

## 1. 准备主机

把仓库克隆到不存放敏感数据的发布目录，例如 `/opt/pi-ai-operations-hub/releases/<version>`。创建 `pi-control`、`pi-telegram`、`pi-weixin` 三个服务账号，并以最小权限创建 `/var/lib/pi-ai-operations-hub/{core,shared,telegram,weixin}`。

## 2. 本地生成配置

参考[`.env.example`](../.env.example)中的变量名，但实际应创建三个仅 root 可读的文件：

```text
/etc/pi-ai-operations-hub/core.env
/etc/pi-ai-operations-hub/telegram.env
/etc/pi-ai-operations-hub/weixin.env
```

使用 `umask 077`；每个文件都应为 root 所有且权限 `0600`。生成五个彼此不同的随机客户端密钥，绝不能拿 AI 提供方密钥充当内部客户端密钥。

## 3. 安装服务

审阅 `systemd/` 下的三个模板；只有在你的目录布局不同的时候才替换文档明确说明的占位路径，然后复制到 `/etc/systemd/system/`。控制核心端口不能通过 Nginx、Cloudflare Tunnel 或防火墙暴露到公网。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pi-control-core.service telegram-control.service weixin-control.service
```

## 4. 配对与验证

只允许一个 Telegram 账户通过私聊 `/start` 配对。高风险密码必须在本机不回显的终端提示中设置。正式使用前至少验证：

- 未配对 Telegram 账户会被拒绝；
- 已配对主人可以执行只读诊断；
- 破坏性请求需要新的确认；
- 微信可以返回状态报告；
- 微信不能创建、取消、批准或修改任务；
- 重启控制核心后状态可恢复且不会泄露凭据。

## 5. 安全运行

网页控制台应置于独立身份验证之后。任何 Token 或客户端密钥一旦可能泄露，应立即轮换；在真正依赖 Telegram 处理网站故障之前，先完成一次故障恢复演练。
