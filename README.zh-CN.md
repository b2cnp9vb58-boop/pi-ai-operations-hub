# Pi AI Operations Hub

[English](README.md) · [架构说明](docs/ARCHITECTURE.zh-CN.md) · [部署说明](docs/DEPLOYMENT.zh-CN.md) · [安全策略](SECURITY.md)

这是一个面向 Raspberry Pi 与 Debian 系 Linux 主机的自托管 AI 运维参考实现。它不是把三个机器人堆在一起，而是让同一个控制核心为三种入口提供不同的、由服务端强制执行的权限：

- **网页控制台**：经认证的管理员控制入口。
- **Telegram**：仅限单一主人使用的应急控制入口；高风险操作必须再次确认。
- **微信**：只读监测秘书；可以汇报状态和已有信息，但不能提交、修改、取消或批准任何控制任务。

核心理念是：**同一个运维大脑，但可操作与只读取必须在服务端分开，而不是只依赖 AI 提示词。**

## 仓库包含内容

- Node.js 24+ 控制核心，以及持久化的 SQLite 任务、事件、对话和确认记录。
- Telegram 单主人配对、幂等更新、结果推送和高风险密码确认。
- 独立的微信身份绑定与只读写入拦截层。
- 网页接入客户端与 Claude 工具调用前的策略 Hook。
- systemd 模板、健康检查、恢复辅助模块和较完整的 Node 测试。
- 中英文架构与部署文档。

## 仓库刻意不包含的内容

不会公开任何真实域名、IP、账号、聊天记录、成绩系统代码、Cloudflare 配置、Token、API Key、Cookie、SSH 密钥、数据库或环境变量文件。

## 安全边界

1. 核心服务只监听 `127.0.0.1`，每个入口使用不同的客户端密钥访问它。
2. Telegram 和网页控制台可以创建任务；微信不可以创建控制任务，也不能访问修改类接口。
3. 未知、破坏性、涉及凭据或会改动配置的工具调用默认拒绝，需要一次性高风险确认。
4. 网关服务使用独立低权限账号；只有本地核心具备完成必要工作的有限权限。
5. 凭据只应放在 `/etc/pi-ai-operations-hub/` 下的 root 专属文件中，绝不能提交到仓库。

## 快速开始

这是参考实现，不是建议直接一键部署到公网的脚本。部署前请完整阅读说明：

```bash
git clone https://github.com/<your-account>/pi-ai-operations-hub.git
cd pi-ai-operations-hub
node --test --test-concurrency=1
python3 -m unittest discover -s tests/portal -v
```

随后按[部署说明](docs/DEPLOYMENT.zh-CN.md)创建服务账号、生成不同密钥、配置 AI 提供方、安装 systemd 服务、配对唯一的 Telegram 主人，并先完成一次微信只读查询测试。

## 许可证

[MIT](LICENSE)
