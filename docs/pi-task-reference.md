# pi-task 参考文档

把 `pi-call.mjs`（`~/tools/pi-call/pi-call.mjs`，仓库里为 `bin/pi-call.mjs`）那套 `pi --mode rpc` 调用包成**可跟踪、可续聊、可取消**的任务。
每个任务一个目录，状态、事件流、提示词和最终回答都落盘；前台跑完即退出，便于 Bot 用 Shell 后台模式启动并及时收到通知。

- Node 22+，零第三方依赖，单文件 `pi-task.mjs`
- 默认等价 `pi-run`：`deepseek/deepseek-flash` + `thinking high` + 读写/执行工具 + web 工具
- 任务 ID 形如 `<会话名>-<YYYYMMDD-HHMMSS>`；会话名就是 Pi 的会话 ID，`reply` 可续聊
- 每个任务带 `owner`（派活 Bot 的 agent id），`pending`/`list`/`ack` 可按 owner 过滤，避免替别的 Bot 汇报或 ack
- 不读取、不打印任何密钥或 `~/.pi/agent/auth.json`

## 用法

```bash
chmod +x pi-task.mjs            # 或 ln -s "$PWD/pi-task.mjs" ~/.local/bin/pi-task

# 新建任务（第一行 stdout 固定是 `TASK <ID>`）
pi-task run <cwd> "<prompt>" --session <会话名> --owner <agent id> [--timeout 秒] \
            [--model provider/model] [--thinking off|low|medium|high] [--no-write] [--no-web]

# 同一会话、同一 cwd 追加一轮（owner 沿用原任务，不接受 --owner）
pi-task reply <ID> "<prompt>" [--timeout 秒]

pi-task status <ID>             # state、owner、耗时、最近 5 条事件
pi-task list [--all] [--owner <id>|none]      # 默认 running / 最近 24h
pi-task log <ID> [-n 30]        # 最近 n 条事件
pi-task cancel <ID>             # 向运行进程发 SIGTERM
pi-task pending [--owner <id>|none]           # 已结束但 reported=false 的任务
pi-task ack <ID> [<ID>...] [--owner <id>|none]   # 标记 reported=true
```

`--timeout` 默认 300 秒，`0` 表示不超时。会话名中的空白和 `/` 会被替换为 `-`（同一份名字同时用于任务 ID 和 Pi 会话 ID）。
如果取消/失败发生在任何 assistant 文本之前，`result.md` 不会存在。

示例：

```bash
$ PI_TASK_DIR=/tmp/tasks ./pi-task.mjs run ~/repo "修复 README 里的错别字" --session docs --owner <your-agent-id>
TASK docs-20261018-151601
STATE done
RESULT /tmp/tasks/docs-20261018-151601/result.md

$ PI_TASK_DIR=/tmp/tasks ./pi-task.mjs reply docs-20261018-151601 "顺便补一段用法示例"
```

Bot 侧典型循环：

```bash
out=$(pi-task run "$cwd" "$prompt" --session "$session" --owner <your-agent-id> --timeout 900)
id=$(printf '%s\n' "$out" | awk '/^TASK /{print $2; exit}')
# ……等待进程退出后：
pi-task pending --owner <your-agent-id>   # 只看自己派的任务
pi-task ack "$id" --owner <your-agent-id>
```

## 归属（owner）

`owner` 记录派活 Bot 的 agent id（自己的 id 见自己 profile 的路径，形如 `/home/box/agent-data/agents/<your-agent-id>/profile.json`），用来保证“谁派的活谁汇报、谁 ack”。

- `run --owner <id>`：写入 `status.json` 的 `owner`。
- 没给 `--owner` 时读环境变量 `PI_TASK_OWNER`；两者都没有，`owner` 记 `null`，任务照常运行，并在 stderr 打印：
  `pi-task: 警告：未指定 --owner，完成通知无法转回派活的 Bot`。
- `reply` 不允许改 owner，沿用原任务的值。
- `--owner` 值不能为空或含空白（否则按用法错误退出，退出码 2）；`--owner none` 是保留值，表示“只看 `owner=null` 的任务”。

过滤规则：

| 命令 | 不带 `--owner` | `--owner <id>` | `--owner none` |
| --- | --- | --- | --- |
| `pending` | 所有未汇报的已结束任务 | 只列该 owner 的 | 只列 `owner=null` 的 |
| `list` | 所有 running / 最近 24h 任务 | 只列该 owner 的 | 只列 `owner=null` 的 |
| `ack` | 照旧全部 ack | owner 不匹配的拒绝（stderr 打印原因，退出码 1） | 非 `null` owner 的拒绝 |

老任务（没有 `owner` 字段）按 `owner=null` 处理，因此用 `--owner none` 可以照看它们。
`ack` 拒绝只影响不匹配的那些任务，匹配的仍会照常 ack；只要有拒绝，退出码就是 1。

`pending`/`list` 每行输出带 `owner=<id|->`（`-` 表示无归属）：

```bash
$ pi-task list --owner <your-agent-id>
news-i18n-20261018-152233  owner=<your-agent-id>  done  runs=1  created=21m ago
```

完成通知的载荷同样是带 owner 的：环境里同时有 `PI_NOTIFY_URL` 和 `PI_NOTIFY_SECRET` 时，任务结束会 POST
`{"source": "pi-task", "id": "docs-20261018-151601", "owner": "<your-agent-id>", "state": "done", "exit_code": 0}`（不含提示词和结果）。
收到通知的 Bot 只处理 `owner` 是自己的任务；别的 Bot 的任务转给 owner 那个 Bot 自己核查、ack。

## 存储

`$PI_TASK_DIR`（默认 `~/.pi/tasks`）`/<任务ID>/`：

| 文件 | 内容 |
| --- | --- |
| `status.json` | 任务状态，临时文件 + `rename` 原子写入 |
| `events.jsonl` | RPC 事件逐行追加；只有 `ts`/`type`/`tool`/`text`，文本单行截断 500 字 |
| `result.md` | 最后一条 assistant 文本（没有文本时为缺失） |
| `prompt-<n>.txt` | 第 n 轮提示词 |

`status.json`：

```json
{
  "id": "docs-20261018-151601",
  "session": "docs",
  "owner": "<your-agent-id>",
  "cwd": "/home/me/repo",
  "model": "deepseek/deepseek-flash",
  "state": "done",
  "pid": null,
  "created_at": "2026-10-18T07:16:01.650Z",
  "started_at": "2026-10-18T07:16:01.652Z",
  "ended_at": "2026-10-18T07:16:03.541Z",
  "exit_code": 0,
  "error": null,
  "reported": false,
  "runs": [
    {"n": 1, "prompt": "修复 README 里的错别字",
     "started_at": "...", "ended_at": "...", "exit_code": 0}
  ],
  "options": {"thinking": "high", "write": true, "web": true}
}
```

`options` 是附加字段：`reply` 用它沿用首次 `run` 的 thinking / 写权限 / web 工具设置。
`owner` 是派活 Bot 的 agent id，未知时为 `null`（老任务没有该字段时同样按 `null` 处理）。

## 状态与退出码

`state ∈ queued | running | done | failed | cancelled | interrupted`

| 退出码 | 含义 |
| --- | --- |
| `0` | 完成（`done`） |
| `1` | 失败（`failed`，错误写进 `error`） |
| `124` | 超时（`failed`，`error="timeout"`） |
| `130` | 取消（`cancelled`） |

超时或收到 SIGTERM/SIGINT 时，脚本先向 Pi 发 `abort`，最多等 5 秒，然后写状态并退出；再次收到信号则立即退出。

每个子命令启动时都会做**孤儿检查**：`status.json` 里还是 `running` 但 pid 已不存在（例如进程被 `kill -9`）的任务会被改成 `interrupted`，并写一条 `orphan_detected` 事件。

`cancel` 向 `status.pid`（即 `pi-task run` 进程，不是 Pi 子进程）发 SIGTERM；若 12 秒内状态仍未变化，则 SIGKILL 并直接把状态记为 `cancelled`。

同一会话（`--session`）同时只允许一个 `running` 任务：`run` 遇到会话被占用、`reply` 遇到目标任务仍在 running 都会直接拒绝（退出码 1）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_TASK_DIR` | `~/.pi/tasks` | 任务存储根目录 |
| `PI_TASK_SESSION_DIR` | `~/.pi/agent/sessions/tasks` | Pi 会话目录（换目录后旧会话不可续） |
| `PI_TASK_OWNER` | 空 | `run` 未给 `--owner` 时的默认 owner；为空则记 `null` 并告警 |
| `PI_NOTIFY_URL` | 空 | 完成通知 Webhook，未设置则不发送 |
| `PI_NOTIFY_SECRET` | 空 | 通知的 Bearer 令牌，仅经环境变量传给子进程 |
| `PI_NOTIFY_OFF` | 空 | 设为 `1` 时临时关闭完成通知 |
| `PI_BIN` | `pi` | Pi 可执行文件 |

## 与 pi-call 的差异

- `pi-call.mjs` 是一次性调用，只把最后文本打到 stdout；`pi-task` 额外落盘状态/事件/结果，并支持 `reply`、`cancel`、`pending`/`ack`。
- `pi-task` 默认使用独立会话目录 `~/.pi/agent/sessions/tasks`（可用 `PI_TASK_SESSION_DIR` 改回 `.../bot` 以便与 `pi-run` 共用会话）。
- RPC 参数（`--mode rpc --session-dir --session-id --name --provider --model --thinking --tools`）与 `pi-call.mjs` 一致；事件流同样只按 LF 分帧，并自动取消 `extension_ui_request`。

自测与排错步骤见 [`setup-guide.md`](setup-guide.md) 第 4–5 节。
