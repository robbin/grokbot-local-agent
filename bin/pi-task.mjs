#!/usr/bin/env node
// pi-task.mjs — tracked, resumable Pi tasks on top of `pi --mode rpc`.
//
// Each task lives in $PI_TASK_DIR (default ~/.pi/tasks)/<id>/ and keeps
// status.json, events.jsonl, prompt-<n>.txt and result.md. See docs/pi-task-reference.md.
// Node 22+, no third-party dependencies.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const TASK_ROOT = resolve(process.env.PI_TASK_DIR || join(homedir(), ".pi", "tasks"));
const SESSION_DIR =
  process.env.PI_TASK_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions", "tasks");
const PI_BIN = process.env.PI_BIN || "pi";

const DEFAULT_MODEL = "deepseek/deepseek-flash";
const DEFAULT_THINKING = "high";
const DEFAULT_TIMEOUT = 300; // seconds, same default as pi-call.mjs
const EVENT_TEXT_MAX = 500;
const TERMINAL = new Set(["done", "failed", "cancelled", "interrupted"]);
const EXIT = { done: 0, failed: 1, timeout: 124, cancelled: 130 };

// ---------------------------------------------------------------- utilities

const iso = () => new Date().toISOString();
// Display in the host's local timezone; store timestamps as ISO UTC.
const lt = (v) => { if (!v) return "-"; const d = new Date(v); if (isNaN(d)) return String(v); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const pad = (n, w = 2) => String(n).padStart(w, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function cleanSession(name) {
  const s = String(name ?? "")
    .replace(/[\\/\s]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!s) throw usageError("invalid session name");
  return s;
}

function validTaskId(id) {
  return typeof id === "string" && /^[^.][^\\/]*$/.test(id) && !id.includes("..");
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function humanAge(isoStr) {
  if (!isoStr) return "-";
  const ms = Date.now() - Date.parse(isoStr);
  if (!Number.isFinite(ms)) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function humanDuration(startIso, endIso) {
  if (!startIso) return "-";
  const end = endIso ? Date.parse(endIso) : Date.now();
  const ms = end - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${pad(rs)}s`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

function shortText(value, max = EVENT_TEXT_MAX) {
  if (value === undefined || value === null || value === "") return undefined;
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return undefined;
  // events.jsonl stays one line per record and free of huge payloads
  s = s.replace(/[\r\n\u2028\u2029\t]+/g, " ⏎ ").trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function usageError(msg) {
  process.stderr.write(`pi-task: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

function fail(msg, code = 1) {
  process.stderr.write(`pi-task: ${msg}\n`);
  process.exit(code);
}

// `process.exit()` can truncate pending pipe writes; wait for stdout/stderr
// to drain before leaving so callers piping our output see every line.
function flushAndExit(code) {
  let left = 2;
  const done = () => {
    if (--left === 0) process.exit(code);
  };
  setTimeout(() => process.exit(code), 2000);
  for (const stream of [process.stdout, process.stderr]) {
    try {
      stream.write("", done);
    } catch {
      done();
    }
  }
}

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

// --------------------------------------------------------------- task store

const taskDir = (id) => join(TASK_ROOT, id);
const statusPath = (id) => join(taskDir(id), "status.json");

function writeStatus(id, status) {
  const dir = taskDir(id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.status.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(tmp, statusPath(id)); // atomic replace
}

function readStatus(id) {
  if (!validTaskId(id)) fail(`invalid task id: ${id}`);
  let raw;
  try {
    raw = readFileSync(statusPath(id), "utf8");
  } catch {
    fail(`task not found: ${id}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`corrupt status.json for task: ${id}`);
  }
}

function appendEvent(dir, type, tool, text) {
  const rec = { ts: iso(), type };
  if (tool) rec.tool = String(tool);
  const t = shortText(text);
  if (t) rec.text = t;
  try {
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(rec)}\n`);
  } catch {
    // never let logging break the run
  }
}

function readEvents(dir, limit) {
  let raw;
  try {
    raw = readFileSync(join(dir, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const picked = limit ? lines.slice(-limit) : lines;
  return picked
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function fmtEvent(rec, max = 120) {
  const t = lt(rec.ts);
  let line = `${t}  ${rec.type || "?"}`;
  if (rec.tool) line += ` ${rec.tool}`;
  if (rec.text) {
    const text = rec.text.length > max ? `${rec.text.slice(0, max)}…` : rec.text;
    line += `  ${text}`;
  }
  return line;
}

function writeResult(dir, text) {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  writeFileSync(join(dir, "result.md"), body);
}

function listTaskIds() {
  let entries;
  try {
    entries = readdirSync(TASK_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// Every subcommand starts here: a task still marked running whose process is
// gone becomes interrupted, otherwise it would look busy forever.
function orphanCheck() {
  let changed = 0;
  for (const id of listTaskIds()) {
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      continue;
    }
    if (status?.state !== "running" && status?.state !== "queued") continue;
    if (status.state === "running" && status.pid && isAlive(status.pid)) continue;
    // A queued record is only stale once its owner had time to start it.
    if (status.state === "queued" && Date.now() - Date.parse(status.created_at || 0) < 60000) {
      continue;
    }
    const end = iso();
    status.state = "interrupted";
    status.ended_at = end;
    status.error = status.error || "orphaned: process no longer running";
    status.pid = null;
    const last = Array.isArray(status.runs) && status.runs.length
      ? status.runs[status.runs.length - 1]
      : null;
    if (last && !last.ended_at) last.ended_at = end;
    try {
      writeStatus(id, status);
      appendEvent(taskDir(id), "orphan_detected", undefined, "state=interrupted");
      changed++;
    } catch {
      // ignore unreadable/unwritable task dirs
    }
  }
  return changed;
}

function assertSessionFree(session, ignoreId) {
  for (const id of listTaskIds()) {
    if (id === ignoreId) continue;
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      continue;
    }
    if (status?.state === "running" && status.session === session) {
      fail(`session "${session}" is already in use by running task ${status.id}`);
    }
  }
}

// ------------------------------------------------------------ pi invocation

function piArgs(session, model, thinking, write, web) {
  const args = [
    "--mode", "rpc",
    "--session-dir", SESSION_DIR,
    "--session-id", session,
    "--name", session,
  ];
  const [provider, ...rest] = String(model).split("/");
  if (provider && rest.length) args.push("--provider", provider, "--model", rest.join("/"));
  else args.push("--model", String(model));
  args.push("--thinking", thinking || DEFAULT_THINKING);
  const tools =
    (write ? "read,grep,find,ls,bash,edit,write" : "read,grep,find,ls") +
    (web ? ",web_search,fetch_content,get_search_content" : "");
  args.push("--tools", tools);
  return args;
}

function toolSummary(args) {
  if (!args || typeof args !== "object") return undefined;
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.pattern === "string") return args.pattern;
  if (typeof args.query === "string") return args.query;
  if (Array.isArray(args.queries)) return args.queries.join(" | ");
  if (typeof args.url === "string") return args.url;
  if (Array.isArray(args.urls)) return args.urls.join(" ");
  const s = JSON.stringify(args);
  return s === "{}" ? undefined : s;
}

function textOf(message) {
  if (!message) return "";
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => c && c.type === "text")
      .map((c) => c.text || "")
      .join("");
  }
  return typeof message.content === "string" ? message.content : "";
}

// Run one prompt turn inside a task, stream events, update status, exit.
// Notify the Bot on completion: POST {source,id,owner,state,exit_code} to PI_NOTIFY_URL.
// A detached notifier receives the Bearer secret via environment, not argv; skip if unconfigured.
function notify(dir, id, owner, state, code) {
  const url = process.env.PI_NOTIFY_URL, key = process.env.PI_NOTIFY_SECRET;
  if (!url || !key || process.env.PI_NOTIFY_OFF) return;
  const js = `const [u,b,f]=process.argv.slice(1);const fs=require("fs");
fetch(u,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+process.env.PI_NOTIFY_SECRET},body:b,signal:AbortSignal.timeout(15000)})
.then(r=>fs.appendFileSync(f,JSON.stringify({ts:new Date().toISOString(),type:"notify",text:"http "+r.status})+"\\n"))
.catch(e=>fs.appendFileSync(f,JSON.stringify({ts:new Date().toISOString(),type:"notify",text:"error "+String(e.message||e).slice(0,200)})+"\\n"));`;
  try {
    const c = spawn(process.execPath, ["-e", js, url, JSON.stringify({ source: "pi-task", id, owner: owner ?? null, state, exit_code: code }), join(dir, "events.jsonl")],
      { detached: true, stdio: "ignore", env: process.env });
    c.unref();
  } catch { /* Notification failure does not affect results; pending provides recovery. */ }
}

function execute(id, prompt, timeoutSec) {
  const dir = taskDir(id);
  const status = readStatus(id);
  const runs = Array.isArray(status.runs) ? status.runs : [];
  const n = runs.length + 1;
  const startedAt = iso();

  writeFileSync(join(dir, `prompt-${n}.txt`), prompt.endsWith("\n") ? prompt : `${prompt}\n`);
  runs.push({ n, prompt, started_at: startedAt, ended_at: null, exit_code: null });
  status.runs = runs;
  status.state = "running";
  status.pid = process.pid;
  if (!status.started_at) status.started_at = startedAt; // first run wins
  status.ended_at = null;
  status.exit_code = null;
  status.error = null;
  writeStatus(id, status);
  appendEvent(dir, "task_start", undefined, prompt);

  const opts = status.options && typeof status.options === "object" ? status.options : {};
  const model = status.model || DEFAULT_MODEL;
  const thinking = opts.thinking || DEFAULT_THINKING;
  const allowWrite = opts.write !== false;
  const allowWeb = opts.web !== false;
  const session = status.session;

  const args = piArgs(session, model, thinking, allowWrite, allowWeb);

  // Remove notification URL/secret and unrelated cloud tokens from the Pi child's environment.
  const piEnv = { ...process.env };
  delete piEnv.PI_NOTIFY_URL; delete piEnv.PI_NOTIFY_SECRET; delete piEnv.CLOUDFLARE_API_TOKEN;
  const child = spawn(PI_BIN, args, {
    cwd: status.cwd,
    env: piEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const send = (obj) => {
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // child already gone; exit handler reports it
    }
  };

  let lastText = "";
  let lastError = "";
  let stderrBuf = "";
  let finished = false;
  let aborting = false;
  let timedOut = false;
  let timeoutTimer = null;
  let graceTimer = null;
  const promptId = `p${n}`;

  const abort = () => {
    appendEvent(dir, "abort_sent", undefined, timedOut ? "timeout" : "signal");
    send({ type: "abort" });
  };

  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);

    const end = iso();
    let st = null;
    try {
      st = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      st = null;
    }
    let state;
    if (code === EXIT.done) state = "done";
    else if (code === EXIT.cancelled) state = "cancelled";
    else state = "failed";
    if (st) {
      st.state = state;
      st.ended_at = end;
      st.exit_code = code;
      st.pid = null;
      if (code === EXIT.timeout) st.error = "timeout";
      else if (code === EXIT.done || code === EXIT.cancelled) st.error = null;
      else st.error = lastError || st.error || "failed";
      const last = Array.isArray(st.runs) && st.runs.length
        ? st.runs[st.runs.length - 1]
        : null;
      if (last) {
        last.ended_at = end;
        last.exit_code = code;
      }
      try {
        writeStatus(id, st);
      } catch {
        // status write failure must not mask the exit code
      }
    }
    if (lastText) {
      try {
        writeResult(dir, lastText);
      } catch {
        // ignore
      }
    }
    appendEvent(dir, "task_end", undefined, `state=${state} exit=${code}`);
    notify(dir, id, st ? st.owner ?? null : status.owner ?? null, state, code);
    const out = `STATE ${state}\nRESULT ${join(dir, "result.md")}\n`;
    process.stdout.write(out);
    if (code !== EXIT.done) {
      const why =
        code === EXIT.cancelled
          ? "cancelled"
          : code === EXIT.timeout
            ? "timeout"
            : st?.error || lastError || stderrBuf.trim() || "failed";
      process.stderr.write(`pi-task: ${why}\n`);
    }

    // Orderly shutdown: EOF on stdin, then a grace kill in case Pi hangs.
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, 3000).unref();
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 8000).unref();
    flushAndExit(code);
  }

  const onSignal = (sig) => {
    if (finished) return;
    if (aborting) {
      finish(EXIT.cancelled); // second signal: stop immediately
      return;
    }
    aborting = true;
    appendEvent(dir, "cancel_requested", undefined, sig);
    abort();
    graceTimer = setTimeout(() => finish(EXIT.cancelled), 5000);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const timeout = Number(timeoutSec);
  if (Number.isFinite(timeout) && timeout > 0) {
    timeoutTimer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      appendEvent(dir, "timeout", undefined, `${timeout}s`);
      abort();
      graceTimer = setTimeout(() => finish(EXIT.timeout), 5000);
    }, timeout * 1000);
  }

  let buf = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      // split on LF only; U+2028/U+2029 are valid inside JSON strings
      let line = buf.subarray(0, i).toString("utf8");
      buf = buf.subarray(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      handleEvent(rec);
    }
  });

  function handleEvent(rec) {
    const type = rec.type;
    if (type === "response") {
      if (rec.id !== promptId) return;
      if (!rec.success) {
        lastError = rec.error || "prompt rejected";
        appendEvent(dir, "error", undefined, lastError);
        finish(EXIT.failed);
      } else if (rec.data?.disposition === "handled") {
        appendEvent(dir, "prompt_handled");
        finish(lastText ? EXIT.done : EXIT.failed);
      }
      return;
    }
    if (type === "agent_start") {
      appendEvent(dir, "agent_start");
      return;
    }
    if (type === "message_end" && rec.message?.role === "assistant") {
      const text = textOf(rec.message);
      if (text) {
        lastText = text;
        try {
          writeResult(dir, text);
        } catch {
          // ignore
        }
      }
      if (rec.message.stopReason === "error" || rec.message.errorMessage) {
        lastError = rec.message.errorMessage || "assistant error";
        appendEvent(dir, "error", undefined, lastError);
      }
      const note =
        text ||
        (rec.message.stopReason && rec.message.stopReason !== "toolUse"
          ? rec.message.stopReason
          : undefined);
      appendEvent(dir, "message_end", undefined, note);
      return;
    }
    if (type === "tool_execution_start") {
      appendEvent(dir, "tool_execution_start", rec.toolName, toolSummary(rec.args));
      return;
    }
    if (type === "tool_execution_end") {
      const duration = Number.isFinite(rec.durationMs) ? `${rec.durationMs}ms` : "";
      appendEvent(
        dir,
        "tool_execution_end",
        rec.toolName,
        [rec.isError ? "error" : "ok", duration].filter(Boolean).join(" "),
      );
      return;
    }
    if (type === "agent_end") {
      appendEvent(dir, "agent_end", undefined, rec.willRetry ? "willRetry" : undefined);
      return;
    }
    if (type === "agent_settled") {
      appendEvent(dir, "agent_settled", undefined, rec.aborted ? "aborted" : undefined);
      if (aborting) finish(EXIT.cancelled);
      else if (timedOut) finish(EXIT.timeout);
      else if (lastError && !lastText) finish(EXIT.failed);
      else finish(lastText ? EXIT.done : EXIT.failed);
      return;
    }
    if (type === "extension_ui_request" && rec.id) {
      send({ type: "extension_ui_response", id: rec.id, cancelled: true });
      appendEvent(dir, "extension_ui_request", undefined, "auto-cancelled");
      return;
    }
    if (type === "extension_error") {
      appendEvent(dir, "extension_error", undefined, rec.error);
      return;
    }
    if (
      type === "compaction_start" ||
      type === "compaction_end" ||
      type === "auto_retry_start" ||
      type === "auto_retry_end" ||
      type === "summarization_retry_finished" ||
      type === "thinking_level_changed" ||
      type === "queue_update"
    ) {
      appendEvent(
        dir,
        type,
        undefined,
        type === "compaction_start"
          ? rec.reason
          : type === "auto_retry_start"
            ? `attempt ${rec.attempt}/${rec.maxAttempts} ${rec.errorMessage || ""}`
            : type === "auto_retry_end"
              ? rec.success
                ? "ok"
                : rec.finalError
              : type === "thinking_level_changed"
                ? rec.level
                : type === "compaction_end"
                  ? rec.aborted
                    ? "aborted"
                    : rec.errorMessage || "ok"
                  : undefined,
      );
    }
  }

  child.stderr?.on("data", (d) => {
    stderrBuf += d.toString("utf8");
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });

  child.on("error", (e) => {
    lastError = `spawn failed: ${e.message}`;
    appendEvent(dir, "error", undefined, lastError);
    finish(EXIT.failed);
  });

  child.on("exit", (code) => {
    if (finished) return;
    lastError ||= `pi exited early (code ${code})`;
    appendEvent(dir, "pi_exit", undefined, `code=${code}`);
    finish(aborting ? EXIT.cancelled : timedOut ? EXIT.timeout : EXIT.failed);
  });

  send({ id: promptId, type: "prompt", message: prompt });
}

// -------------------------------------------------------------- subcommands

// Owner routing: Bots should ack only their own tasks using an owner filter.
// Store a string or null; legacy tasks without this field are treated as null.
const OWNER_NONE = "none";

function taskOwner(flags) {
  if (flags.owner !== undefined) {
    const s = String(flags.owner).trim();
    if (!s) usageError(`--owner needs a non-empty value: ${JSON.stringify(flags.owner)}`);
    if (/\s/.test(s)) usageError(`invalid --owner (no whitespace): ${flags.owner}`);
    return s;
  }
  const env = String(process.env.PI_TASK_OWNER ?? "").trim();
  if (env) {
    if (!/\s/.test(env)) return env;
    process.stderr.write(`pi-task: warning: invalid PI_TASK_OWNER (contains whitespace): ${env}\n`);
  }
  process.stderr.write("pi-task: warning: --owner was not specified; completion cannot be routed to the dispatching Bot\n");
  return null;
}

// Owner filter: undefined = all; null = unowned only; string = exact match.
function ownerFilter(flags) {
  if (flags.owner === undefined) return undefined;
  const s = String(flags.owner).trim();
  if (!s) usageError("--owner needs a non-empty value (--owner none matches unowned tasks)");
  return s === OWNER_NONE ? null : s;
}

function ownerMatches(status, filter) {
  if (filter === undefined) return true;
  const owner = status?.owner ?? null;
  return filter === null ? owner === null : owner === filter;
}

const ownerLabel = (status) => {
  const owner = status?.owner;
  return owner === undefined || owner === null || owner === "" ? "-" : String(owner);
};

function timeoutOf(flags) {
  if (flags.timeout === undefined) return DEFAULT_TIMEOUT;
  const n = Number(flags.timeout);
  if (!Number.isFinite(n) || n < 0) usageError(`invalid --timeout: ${flags.timeout}`);
  return n;
}

function newTaskId(session) {
  const base = `${session}-${stamp()}`;
  let id = base;
  let i = 2;
  while (existsSync(taskDir(id))) id = `${base}-${i++}`;
  return id;
}

function cmdRun(pos, flags) {
  const timeoutSec = timeoutOf(flags);
  const cwdArg = pos[0];
  const prompt = pos[1];
  if (!cwdArg || prompt === undefined || prompt === "") {
    usageError('run needs <cwd> and a non-empty "<prompt>"');
  }
  if (!flags.session) usageError("run needs --session <name>");
  const cwd = resolve(cwdArg);
  if (!isDir(cwd)) usageError(`cwd is not a directory: ${cwd}`);
  const session = cleanSession(flags.session);
  assertSessionFree(session);
  const owner = taskOwner(flags);

  const id = newTaskId(session);
  const status = {
    id,
    session,
    owner,
    cwd,
    model: typeof flags.model === "string" && flags.model ? flags.model : DEFAULT_MODEL,
    state: "queued",
    pid: null,
    created_at: iso(),
    started_at: null,
    ended_at: null,
    exit_code: null,
    error: null,
    reported: false,
    runs: [],
    options: {
      thinking:
        typeof flags.thinking === "string" && flags.thinking ? flags.thinking : DEFAULT_THINKING,
      write: !flags["no-write"],
      web: !flags["no-web"],
    },
  };
  writeStatus(id, status);
  process.stdout.write(`TASK ${id}\n`);
  execute(id, prompt, timeoutSec);
}

function cmdReply(pos, flags) {
  const timeoutSec = timeoutOf(flags);
  const id = pos[0];
  const prompt = pos[1];
  if (!id || prompt === undefined || prompt === "") {
    usageError('reply needs <id> and a non-empty "<prompt>"');
  }
  if (flags.owner !== undefined) {
    usageError("reply retains the original task owner and does not accept --owner");
  }
  const status = readStatus(id);
  if (status.state === "running") fail(`task ${id} is still running; wait or cancel it first`);
  if (!TERMINAL.has(status.state)) fail(`task ${id} is in state ${status.state}`);
  if (!isDir(status.cwd)) fail(`task cwd no longer exists: ${status.cwd}`);
  assertSessionFree(status.session, id);
  execute(id, prompt, timeoutSec);
}

function cmdStatus(pos) {
  const id = pos[0];
  if (!id) usageError("status needs <id>");
  const status = readStatus(id);
  const dir = taskDir(id);
  const resultPath = join(dir, "result.md");
  const events = readEvents(dir, 5);
  const lines = [
    `id:       ${status.id}`,
    `state:    ${status.state}`,
    `owner:    ${ownerLabel(status)}`,
    `session:  ${status.session}`,
    `model:    ${status.model}`,
    `cwd:      ${status.cwd}`,
    `created:  ${lt(status.created_at)} (${humanAge(status.created_at)} ago)`,
    `started:  ${lt(status.started_at)}`,
    `ended:    ${lt(status.ended_at)}`,
    `duration: ${humanDuration(status.started_at, status.ended_at)}`,
    `runs:     ${Array.isArray(status.runs) ? status.runs.length : 0}`,
    `result:   ${resultPath}${existsSync(resultPath) ? "" : " (missing)"}`,
    `reported: ${status.reported === true}`,
  ];
  if (status.error) lines.push(`error:    ${status.error}`);
  lines.push("events:");
  if (!events.length) lines.push("  (none)");
  for (const ev of events) lines.push(`  ${fmtEvent(ev, 100)}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdList(flags) {
  const ids = listTaskIds().sort();
  const filter = ownerFilter(flags);
  const rows = [];
  for (const id of ids) {
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      continue;
    }
    const created = status.created_at ? Date.parse(status.created_at) : NaN;
    const recent = Number.isFinite(created) && Date.now() - created < 24 * 3600 * 1000;
    if (!flags.all && status.state !== "running" && !recent) continue;
    if (!ownerMatches(status, filter)) continue;
    rows.push({ status, created });
  }
  rows.sort((a, b) => (b.created || 0) - (a.created || 0));
  for (const { status } of rows) {
    const runs = Array.isArray(status.runs) ? status.runs.length : 0;
    process.stdout.write(
      `${status.id}  owner=${ownerLabel(status)}  ${status.state}  runs=${runs}  ` +
        `created=${humanAge(status.created_at)} ago\n`,
    );
  }
}

function cmdLog(pos, flags) {
  const id = pos[0];
  if (!id) usageError("log needs <id>");
  readStatus(id); // validates existence
  const n = Number.parseInt(flags.n ?? "30", 10);
  const limit = Number.isFinite(n) && n > 0 ? n : 30;
  const events = readEvents(taskDir(id), limit);
  if (!events.length) {
    process.stdout.write("(no events)\n");
    return;
  }
  for (const ev of events) process.stdout.write(`${fmtEvent(ev)}\n`);
}

async function cmdCancel(pos) {
  const id = pos[0];
  if (!id) usageError("cancel needs <id>");
  const status = readStatus(id);
  if (status.state !== "running") fail(`task ${id} is not running (state=${status.state})`);
  if (!status.pid || !isAlive(status.pid)) {
    // Reaching here means another subcommand has not noticed yet.
    const deadPid = status.pid;
    const end = iso();
    status.state = "interrupted";
    status.ended_at = end;
    status.error = status.error || "orphaned: process no longer running";
    status.pid = null;
    writeStatus(id, status);
    appendEvent(taskDir(id), "orphan_detected", undefined, "state=interrupted");
    fail(`task ${id}: process ${deadPid ?? "(none)"} not running, marked interrupted`);
  }

  appendEvent(taskDir(id), "cancel_signal", undefined, `SIGTERM -> ${status.pid}`);
  try {
    process.kill(status.pid, "SIGTERM");
  } catch (e) {
    fail(`could not signal pid ${status.pid}: ${e.message}`);
  }

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(200);
    let now;
    try {
      now = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      now = null;
    }
    if (!now || now.state !== "running") {
      const state = now?.state || "unknown";
      process.stdout.write(`CANCELLED ${id} state=${state}\n`);
      return;
    }
  }

  // The run process did not finish in time: force it and record the outcome.
  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
    // already gone
  }
  const end = iso();
  status.state = "cancelled";
  status.ended_at = end;
  status.exit_code = EXIT.cancelled;
  status.pid = null;
  status.error = "cancelled (forced after SIGTERM timeout)";
  const last = Array.isArray(status.runs) && status.runs.length
    ? status.runs[status.runs.length - 1]
    : null;
  if (last) {
    last.ended_at = end;
    last.exit_code = EXIT.cancelled;
  }
  writeStatus(id, status);
  appendEvent(taskDir(id), "cancel_forced", undefined, "SIGKILL");
  process.stdout.write(`CANCELLED ${id} state=cancelled (forced)\n`);
}

function cmdPending(flags) {
  const filter = ownerFilter(flags);
  const rows = [];
  for (const id of listTaskIds()) {
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath(id), "utf8"));
    } catch {
      continue;
    }
    if (!TERMINAL.has(status.state)) continue;
    if (status.reported === true) continue;
    if (!ownerMatches(status, filter)) continue;
    rows.push(status);
  }
  rows.sort((a, b) => String(a.ended_at || "").localeCompare(String(b.ended_at || "")));
  for (const status of rows) {
    const result = join(taskDir(status.id), "result.md");
    process.stdout.write(
      `${status.id}  owner=${ownerLabel(status)}  ${status.state}  ended=${lt(
        status.ended_at,
      )}  result=${result}${existsSync(result) ? "" : " (missing)"}\n`,
    );
  }
}

function cmdAck(pos, flags) {
  const ids = pos.filter(Boolean);
  if (!ids.length) usageError("ack needs <id> [<id>...]");
  const filter = ownerFilter(flags);
  const refused = [];
  for (const id of ids) {
    const status = readStatus(id);
    if (!ownerMatches(status, filter)) {
      const why =
        filter === null
          ? `owner=${ownerLabel(status)} does not match --owner none`
          : `owner=${ownerLabel(status)} does not match --owner ${filter}`;
      process.stderr.write(`pi-task: refusing ack ${id}: ${why} (cannot ack another Bot's task)\n`);
      refused.push(id);
      continue;
    }
    status.reported = true;
    writeStatus(id, status);
    appendEvent(taskDir(id), "ack", undefined, "reported=true");
    process.stdout.write(`ACK ${id}  owner=${ownerLabel(status)}\n`);
  }
  if (refused.length) flushAndExit(1);
}

// ------------------------------------------------------------------- argv

const VALUE_FLAGS = new Set(["session", "timeout", "model", "thinking", "n", "owner"]);
const BOOL_FLAGS = new Set(["no-write", "no-web", "all", "help"]);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-n") {
      if (i + 1 >= argv.length) usageError("missing value for -n");
      flags.n = argv[++i];
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        const name = a.slice(2, eq);
        if (!VALUE_FLAGS.has(name)) usageError(`unknown option: --${name}`);
        flags[name] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        if (i + 1 >= argv.length) usageError(`missing value for --${name}`);
        flags[name] = argv[++i];
      } else if (BOOL_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        usageError(`unknown option: --${name}`);
      }
      continue;
    }
    pos.push(a);
  }
  return { flags, pos };
}

const USAGE = `usage:
  pi-task run <cwd> "<prompt>" --session <name> [--owner <agent id>] [--timeout sec]
              [--model provider/model] [--thinking off|low|medium|high]
              [--no-write] [--no-web]
  pi-task reply <id> "<prompt>" [--timeout sec]      (retains the original owner)
  pi-task status <id>
  pi-task list [--all] [--owner <agent id>|none]
  pi-task log <id> [-n 30]
  pi-task cancel <id>
  pi-task pending [--owner <agent id>|none]
  pi-task ack <id> [<id>...] [--owner <agent id>|none]

  --owner <id>  dispatching agent; defaults to PI_TASK_OWNER, or null with a warning
  --owner none  match only tasks with owner=null

env:
  PI_TASK_DIR          task store (default ~/.pi/tasks)
  PI_TASK_SESSION_DIR  Pi session dir (default ~/.pi/agent/sessions/tasks)
  PI_TASK_OWNER        default owner for run (fallback when --owner is absent)
  PI_BIN               pi executable (default: pi)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const { flags, pos } = parseArgs(rest);
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  const known = new Set([
    "run", "reply", "status", "list", "log", "cancel", "pending", "ack",
  ]);
  if (!known.has(cmd)) usageError(`unknown command: ${cmd}`);

  orphanCheck();

  switch (cmd) {
    case "run":
      return cmdRun(pos, flags);
    case "reply":
      return cmdReply(pos, flags);
    case "status":
      return cmdStatus(pos);
    case "list":
      return cmdList(flags);
    case "log":
      return cmdLog(pos, flags);
    case "cancel":
      return cmdCancel(pos);
    case "pending":
      return cmdPending(flags);
    case "ack":
      return cmdAck(pos, flags);
  }
}

main().catch((e) => {
  process.stderr.write(`pi-task: ${e?.message || e}\n`);
  process.exit(1);
});
