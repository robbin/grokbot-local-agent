---
name: pi-agent
description: >-
  当用户要求“让 Pi 做/看/审”、“用 Pi Agent”、“让另一家模型出第二意见或做对比”，或遇到批量文件处理、写代码、长篇调研和联网搜索、
  长文初稿这类重活时使用：为节省 Bot 自身用量，这些默认交给 Bot 电脑上的 Pi Agent。通过原生 RPC 模式调用，按任务名保存会话以便连续修改。
---
# 调用 Bot 电脑上的 Pi Agent

Pi 是装在 Bot 电脑上的命令行编码 Agent，默认模型 DeepSeek Flash、思考级别 high，能读写文件、执行命令和联网搜索。详细安装与配置见仓库里的 `docs/setup-guide.md`。脚本装在 `~/tools/pi-call/`（仓库的 `bin/` 目录）。

## 用量策略
Bot 自身的模型用量有限，Pi 跑的是用户自己的模型账号（默认 DeepSeek），额度与 Bot 分开计算。所以重活默认交给 Pi，Bot 只做调度和把关。

交给 Pi：
- 批量文件处理：批量改文件、整理数据、格式转换。
- 写代码：脚本、小工具、测试、调试。
- 长篇调研和联网搜索。
- 长文初稿：文档、报告、文章的第一版。
- 用户点名要 Pi 做、要第二意见或同题对比。

Bot 自己做：
- 简短对话和能一两步答完的问题。
- 连接器操作（Gmail、X、GitHub 等），Pi 没有这些连接。
- 发送、发布、推送、部署前的确认，以及向用户汇报。

做法：
- 指令要短：写清目标、输入在哪、输出写到哪个文件、完成标准，几行就够，不要把大段原文贴进提示词，让 Pi 自己读文件。
- 结果直接存成文件：在提示词里指定输出路径，让 Pi 写文件；Bot 核查后直接交付这个文件，不再自己重写一遍。需要改就带同一会话让 Pi 改。
- 关键结论要落地：任务得出的重要结论、决定或数据，由 Bot 主动写进记忆或相关文档，不要只留在 Pi 的会话里。

## 步骤
1. 确定工作目录：只给 Pi 完成任务需要的那个目录（仓库或 `/tmp/<任务>`），不要给 `/` 或整个家目录。
2. 起会话名：简短的英文 kebab-case，一个任务一个名字（如 `news-i18n`）。同一任务的后续修改沿用同名；想从头开始就换新名字。
3. 定输出位置：没有更合适的目标位置时，用 `/tmp/pi-out/<会话名>/`；要留存或同步的成果，直接写到它该去的地方（对应仓库、文档或笔记目录）。
4. 写提示词：短而完整，讲清目标、约束、输出文件路径、完成标准，最后让它回报写了哪些文件和一句话结论。Pi 看不到聊天记录，必要背景用一两句交代，长材料给文件路径。
5. 调用。超过一两分钟的任务一律用 `pi-task`，它会给任务编号并记录状态和过程，结果存成文件：
   ```bash
   ~/tools/pi-call/pi-task run <工作目录> "<提示词>" --session <会话名> --owner <your-agent-id> [--timeout 秒] [--no-write] [--no-web]
   ```
   `--owner` 必须写：它把任务标给派活的 Bot，完成通知才找得到人，`pending`/`ack` 也靠它防止不同 Bot 互相抢汇报、替别人的任务 ack。不写虽然照样跑（owner 记 `null`，stderr 给一句警告），但通知就转不回来了。（也可以由环境变量 `PI_TASK_OWNER` 提供默认值，但显式传更稳。）自己的 agent id 在自己的 profile 路径里（形如 `/home/box/agent-data/agents/<your-agent-id>/profile.json`）。
   用 Shell 工具自带的后台运行（不阻塞），**不要用 `nohup`、`&` 或 `setsid`**。输出第一行是 `TASK <任务ID>`；结束时打印状态和 `result.md` 路径。退出码：0 完成，1 失败，124 超时，130 取消。
   其他子命令：`status <ID>`（状态、owner、耗时、最近事件）、`log <ID> [-n 30]`、`list [--all] [--owner <id>|none]`、`cancel <ID>`、`pending [--owner <id>|none]`（已结束但还没汇报的任务）、`ack <ID> [--owner <id>|none]`（标记已汇报；owner 不匹配的拒绝，退出码 1）。
   任务数据在 `~/.pi/tasks/<任务ID>/`：`status.json`、`events.jsonl`、`result.md`、`prompt-<n>.txt`。Bot 电脑重启后，还在跑的任务会被标成 `interrupted`，问用户要不要重跑。
   **完成通知：** 环境里有 `PI_NOTIFY_URL` 和 `PI_NOTIFY_SECRET` 时（存成 Bot 电脑的环境变量，不写进文件），`pi-task` 每跑完一个任务就向这个 Webhook 发一条 `{source, id, owner, state, exit_code}`，不带任务内容。接收它的例行任务被唤醒后跑 `pending --owner <自己的 id>`，核查、汇报、`ack --owner <自己的 id>`。只处理 owner 是自己的任务；别的 Bot 的任务不核查不 ack，用 SendToAgent（priority true）转给 owner 那个 Bot，例行任务环境发不了消息就交回 Bot 本体转发；无 owner 的只提醒用户，不 ack。别的 Bot 转来的、owner 是自己的任务，自己核查、汇报并 `ack`。没有配置就自动跳过，发送结果记在 `events.jsonl` 的 `notify` 事件里；设置 `PI_NOTIFY_OFF=1` 可以临时关闭。
   **兜底汇报：** 完成通知可能收不到。所以每次被唤醒（用户发消息、例行任务等）且有派给 Pi 的任务时，先跑一次 `pi-task pending --owner <自己的 id>`，只看自己派的任务，把结束了但还没汇报的任务核查后交付，然后 `ack <ID> --owner <自己的 id>`；只 ack 自己的，别人的任务留给派活的那个 Bot。
   几十秒内能完成的短问答，可以直接前台调用：
   ```bash
   ~/tools/pi-call/pi-run <工作目录> "<提示词>" --session <会话名> [--timeout 秒]
   ```
   需要只读或换模型时用底层脚本：
   ```bash
   ~/tools/pi-call/pi-call.mjs <工作目录> deepseek/deepseek-flash "<提示词>" --thinking high [--allow-write] [--no-web] [--session <会话名>] [--timeout 秒]
   ```
   `pi-run` 和 `pi-call.mjs`：标准输出只有 Pi 的最后一段回复；默认超时 300 秒；退出码 0 成功，1 出错，124 超时，127 找不到 pi。
   权限：`pi-task run` 和 `pi-run` 默认开放全部工具（读、搜索、执行命令、写文件、联网搜索）；`pi-call.mjs` 不带 `--allow-write` 时只有只读工具。
6. 核查结果：Pi 的回复只是它的说法。用 `git diff`、跑测试或读文件确认它真的做了，再向用户转述；不要把未核实的结论当事实。
7. 继续修改：`pi-task` 的任务用 `pi-task reply <任务ID> "<要改什么>"`（同一会话、同一目录、沿用原任务的 owner，任务还在跑时会被拒绝）；`pi-run` 的任务带同一个 `--session` 再调一次。两者的会话分开存放，不能互相续接。

## 规则
- 用的是用户自己的模型额度（联网搜索走用户自己的搜索服务额度），按需调用，不做无意义的重复或大批量空跑。
- 推送代码、部署、改 DNS 或线上服务、发消息或邮件、删除重要文件，都不交给 Pi；这些由 Bot 自己做，并先征得用户同意。
- 不让 Pi 读取或输出 `~/.pi/agent/auth.json`、密钥文件或环境变量里的 key。
- 不 ack 别人的任务：`pending`/`ack` 都带 `--owner <自己的 id>`，owner 不匹配就交给派活的 Bot。
- 用户可见的回复里说“让 Pi 做了 X”，说明结果和你核查过什么。

## 排错
- `pi: command not found`：先 `export PATH=$HOME/.local/bin:$HOME/.node22/bin:$PATH`。
- 提示没有可用模型：DeepSeek 登录失效，需要用户在桌面终端运行 `pi` 并 `/login` 重新登录；Bot 不能替用户登录。
- 超时：拆小任务，或加大 `--timeout`。
- 出错或结果不对：先看退出码和 `--verbose` 日志；任务本身做错了就带同一会话指出问题让 Pi 重做，最多重试一两次。仍不行就由 Bot 自己接手，并告诉用户 Pi 哪里没做好，不要反复空跑。
