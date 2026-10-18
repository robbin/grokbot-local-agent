# Webhook 例行任务：Pi 任务完成通知

Grok Bot 的例行任务（Routine）配置模板。`pi-task` 每跑完一个任务会向 Webhook 发一条只含 `{id, state, exit_code}` 的通知；这个例行任务被唤醒后，回来读取磁盘上的真实状态，核查并汇报。

## 怎么建

1. 打开 Bot 的例行任务面板，新建任务，触发方式选 **Webhook**。
2. 名字随意，例如「Pi 任务完成通知」。
3. 指令栏粘贴下面的模板，保存。
4. 复制这个任务的 **Webhook URL** 和 **Webhook key**，通过 Bot 的安全输入框存成两个环境变量：`PI_NOTIFY_URL`、`PI_NOTIFY_SECRET`。不要写进脚本、任务文件、仓库或提示词。
5. 确认例行任务处于启用状态。`pi-task` 只在两个环境变量都存在时才发通知，否则静默跳过（可用 `PI_NOTIFY_OFF=1` 临时关闭）。
6. 验证：跑一个小任务，看 `~/.pi/tasks/<ID>/events.jsonl` 里是否出现 `{"type":"notify","text":"http 200"}`，以及聊天里是否收到汇报。步骤见 [`../docs/setup-guide.md`](../docs/setup-guide.md) 第 5 节。

## 指令模板

```text
你是值班助手。收到 Pi 任务完成通知后，按以下步骤处理：

1. 先运行 ~/tools/pi-call/pi-task pending，列出所有已结束但未汇报的任务。
   没有任何输出就只回复“无待汇报任务”，不要发消息给用户，结束。
2. 对每个任务：pi-task status <ID> 看状态和退出码；读 ~/.pi/tasks/<ID>/result.md，
   必要时看 events.jsonl 或 log；用 git diff、跑测试、读产物核查 Pi 真的做了它说的事。
3. 汇报任务 ID、状态（done/failed/cancelled/interrupted）、一句话结论、核查了什么、
   产物路径。失败或超时说明原因并问是否重跑，不要自动重跑。
4. 核查并汇报完成后执行 pi-task ack <ID>；核查没通过就保留 pending 并说明卡在哪。
5. 除了 `pi-task ack` 之外，不要手动修改 ~/.pi/tasks 下的文件，不读取任何密钥或 auth.json，
   不替用户推送、部署或对外发消息。
```

通知体只有 `{source, id, state, exit_code}`，不含提示词和结果，所以必须靠 `pending` + 读文件才知道干了什么。

## 说明

- **通知可能丢**：投递失败、Bot 重启、Webhook 并发排队都会导致收不到。结果始终在磁盘上，用户下次发消息时也应先跑一次 `pi-task pending`。
- **通知失败不影响任务本身**：`events.jsonl` 里的 `notify` 事件会记下发送结果（`http 200` 或 `error ...`），任务状态和 `result.md` 照常可读。
- **不要因为没收到通知就重跑任务**：先 `pending` 补汇报，再决定是否需要重跑。
