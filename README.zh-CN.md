# grokbot-local-agent

[English](README.md) | 简体中文

让 Grok Bot 把重活交给同一台机器上的 Pi Agent；任务完成后，通过 Webhook 唤醒 Bot，核查结果并向用户汇报。

这里的“本地”指 Bot 所在的 Linux 云电脑，不是用户自己的 Mac。英文文档和技能是主要维护版本；Bot 和 Pi 对用户的回复仍应使用用户偏好的语言。

## 解决什么问题

批量文件处理、写代码、长文初稿和调研会消耗不少 Bot 对话轮次。交给使用独立模型账号的 Pi 后，如果只启动一个后台命令，任务结束时原来的 Bot 对话可能已经结束，没人接收结果。

本项目把调用包装成可追踪的任务：

```text
Grok Bot → pi-task → 同机 Pi Agent
                ↓
       状态、事件、结果落盘
                ↓
       Webhook 唤醒例行任务
                ↓
       Bot 核查 → 汇报 → ack
```

每个任务保存在 `~/.pi/tasks/<ID>/`。完成通知只含 `{source, id, owner, state, exit_code}`，不包含提示词或结果。

通知是帮助及时处理的机制，磁盘记录才是事实来源。通知丢失时，在下次唤醒后用 `pending` 找回未汇报结果，不要因此重跑任务。

## 适用范围

这是 Bot 云电脑上的轻量“第二双手”，不是独立沙箱或长期任务托管服务。云环境的进程生命周期、隔离能力和权限限制仍然存在。

作者的分工是：Bot 负责对话、调度、连接器及核查；Pi 负责批量处理、小脚本、草稿与调研；需要长期迭代的完整项目可考虑 Cursor Cloud Agent 等专门环境。这是工作流选择，不是本项目的安装依赖。

## 快速上手

完整步骤见 [英文安装说明](docs/setup-guide.md)。以下操作都在 Bot 电脑上进行。

### 1. 准备 Node 22+，安装 Pi

先检查已有环境；下面的 PATH 假定 Node 已安装在 `~/.node22`，命令本身不会安装 Node。无需 sudo。

```bash
export PATH=$HOME/.node22/bin:$HOME/.local/bin:$PATH
node --version
npm i -g --prefix ~/.local @earendil-works/pi-coding-agent
pi --version && which pi
```

### 2. 由用户本人登录模型

在交互终端运行 `pi`，输入 `/login`，选择当前版本和账号支持的订阅登录／服务商，完成授权。不要让 Agent 查看或复制 `~/.pi/agent/auth.json`；Pi 运行时自行处理认证。

`pi --list-models deepseek` 可以查看模型列表，但列出模型不等于认证成功，仍需下面的执行测试。默认模型是 `deepseek/deepseek-flash`，可通过 `pi-task run --model provider/model` 指定可用模型；`pi-run` 的固定模型写在包装脚本中。

### 3. 放置脚本

在本仓库根目录运行：

```bash
mkdir -p ~/tools/pi-call && cp -a bin/. ~/tools/pi-call/
chmod +x ~/tools/pi-call/pi-run ~/tools/pi-call/pi-call.mjs ~/tools/pi-call/pi-task ~/tools/pi-call/pi-task.mjs
```

包装脚本从自身所在目录查找 `.mjs`。保持文件放在一起，并确保 Bot 的 Shell 能找到 `node` 和 `pi`。

### 4. 简单自测

```bash
~/tools/pi-call/pi-run /tmp "只回复 OK 两个字母" --timeout 120
echo "exit=$?"
```

预期得到 `OK` 和 `exit=0`。

### 5. 配置完成通知

按 [例行任务模板](routines/pi-task-notify.md) 建立 Webhook 例行任务，将其中的 `YOUR_AGENT_ID` 替换为接收 Bot 的实际 ID。

通过宿主的安全输入功能提供 `PI_NOTIFY_URL` 和 `PI_NOTIFY_SECRET`。后者是原始 Bearer token，不含 `Bearer` 前缀；先核对实际端点要求，不要把签名密钥当成 Bearer token。凭据不写入仓库、提示词或脚本。

派活时显式带 `--owner YOUR_AGENT_ID`；执行完整的 [端到端检查](docs/setup-guide.md#5-end-to-end-check)，确认通知、核查、汇报和 ack 都成功。最后安装 [pi-agent 技能](skills/pi-agent/SKILL.md)。

## 日常使用与边界

- 长任务用 `pi-task run`，通过 Bot Shell 自带后台模式运行；记下 `TASK <ID>`。
- `pending --owner YOUR_AGENT_ID` 查看自己已结束但未汇报的任务。
- 读结果、检查 diff／测试后向用户汇报，再 `ack <ID> --owner YOUR_AGENT_ID`。
- 不带 owner 过滤的 ack 不会检查归属；Bot 使用时始终带自己的 owner。
- 别的 Bot 的任务转给其 owner；无 owner 的任务只提醒用户，不自行核查或 ack。
- 后续修改用 `reply <ID>`，沿用会话、目录和 owner；失败或超时不自动重跑。
- 不让 Pi 读取密钥或替用户发布、部署、发消息、删除重要文件。相关操作仍需用户授权。

## 文档与文件

| 入口 | 内容 |
| --- | --- |
| [安装说明](docs/setup-guide.md) | 环境、登录、Webhook、验证和排错 |
| [命令参考](docs/pi-task-reference.md) | 子命令、归属、存储、退出码、环境变量 |
| [例行任务模板](routines/pi-task-notify.md) | 收到通知后按 owner 处理 |
| [技能](skills/pi-agent/SKILL.md) | 委派范围、调用步骤、核查与权限边界 |
| `bin/pi-call.mjs`、`bin/pi-run` | 一次性同步调用 |
| `bin/pi-task`、`bin/pi-task.mjs` | 有记录的任务调用与结果通知 |
| [`tools/pi-telegram-monitor/`](tools/pi-telegram-monitor/README.md) | 可选：把 Pi 会话实时推到 Telegram |

## 可选：在 Telegram 里旁观 Pi 会话

[`tools/pi-telegram-monitor/`](tools/pi-telegram-monitor/README.md) 把 Pi 会话实时推到 Telegram 私聊，手机上就能看委派出去的活进展到哪。

- 每个会话一条进度消息，原地滚动更新：指令摘要、工具调用和参数摘要、回复预览、状态（运行中／完成）。
- 回复结束时另发一条“结果”消息，带最终回复全文，过长自动拆成多条。
- 只发不收：不读取 Telegram 更新，不接受任何指令。
- 发送前遮蔽疑似密钥（API key、GitHub token、Bearer、bot token、长 hex／base64 串）；思考内容和工具输出正文不推送。

配置：用 @BotFather 建 bot 拿到 token → 给 bot 发一条消息，查到自己的数字 chat_id → 用宿主的安全输入把 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` 存成环境变量（不写文件、不放提示词）→ 把目录放到 Bot 电脑上，运行 `./start.sh`。

保活：`start.sh` 是幂等的，可在已有的定期例行任务或开机检查里调用；该环境拿不到 token 时直接跳过，不要把 token 写进文件。

## License

[MIT](LICENSE)。
