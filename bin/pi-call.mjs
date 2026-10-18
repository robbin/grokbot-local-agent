#!/usr/bin/env node
// pi-call.mjs — drive Pi via native RPC mode (pi --mode rpc), like Paseo.
// Usage: pi-call.mjs <cwd> <provider/model> <prompt...> [--allow-write] [--thinking off|low|medium|high] [--timeout sec] [--verbose] [--no-web] [--session <name>]
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const args = process.argv.slice(2);
const take = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const allowWrite = has("--allow-write"), verbose = has("--verbose"), noWeb = has("--no-web");
const thinking = take("--thinking") ?? "off";
const sessionName = take("--session"); // named, resumable session
const sessionDir = process.env.PI_CALL_SESSION_DIR || (process.env.HOME + "/.pi/agent/sessions/bot");
const timeoutSec = Number(take("--timeout") ?? 300);
const [cwdArg, modelArg, ...rest] = args;
if (!cwdArg || !modelArg || !rest.length) { console.error("usage: pi-call.mjs <cwd> <provider/model> <prompt> [--allow-write] [--thinking lvl] [--timeout sec] [--verbose]"); process.exit(2); }
const [provider, ...idp] = modelArg.split("/");
const web = noWeb ? "" : ",web_search,fetch_content,get_search_content"; // pi-web-access extension tools
const tools = (allowWrite ? "read,grep,find,ls,bash,edit,write" : "read,grep,find,ls") + web;
const child = spawn(process.env.PI_BIN || "pi",
  ["--mode", "rpc", ...(sessionName ? ["--session-dir", sessionDir, "--session-id", sessionName, "--name", sessionName] : ["--no-session"]), "--provider", provider, "--model", idp.join("/"), "--thinking", thinking, "--tools", tools],
  { cwd: resolve(cwdArg), stdio: ["pipe", "pipe", verbose ? "inherit" : "pipe"] });
let stderr = ""; child.stderr?.on("data", (d) => { stderr += d; });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
let lastText = "", lastError = "", done = false, exitCode = 1;
const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("") : typeof m?.content === "string" ? m.content : "");
const finish = (code) => { if (done) return; done = true; exitCode = code; clearTimeout(timer); child.stdin.end(); setTimeout(() => child.kill("SIGTERM"), 5000).unref(); };
const timer = setTimeout(() => { console.error(`timeout after ${timeoutSec}s`); send({ id: "abort", type: "abort" }); finish(124); }, timeoutSec * 1000);
let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]); let i;
  while ((i = buf.indexOf(10)) >= 0) {           // split on LF only (not U+2028/2029)
    let line = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1); if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (verbose) console.error("[rpc]", r.type, r.command ?? "");
    if (r.type === "response" && r.id === "p1") {
      if (!r.success) { lastError = r.error; finish(1); }
      else if (r.data?.disposition === "handled") finish(0);
    } else if (r.type === "message_end" && r.message?.role === "assistant") {
      const t = textOf(r.message); if (t) lastText = t;
      if (r.message.stopReason === "error" || r.message.errorMessage) lastError = r.message.errorMessage || "assistant error";
    } else if (r.type === "extension_ui_request" && r.id) {
      send({ type: "extension_ui_response", id: r.id, cancelled: true }); // non-interactive
    } else if (r.type === "agent_settled") finish(lastText ? 0 : 1);
  }
});
child.on("error", (e) => { console.error("spawn failed:", e.message); process.exit(127); });
child.on("exit", (code) => {
  if (!done) { lastError ||= `pi exited early (code ${code})`; exitCode = 1; clearTimeout(timer); }
  if (lastText) process.stdout.write(lastText + "\n");
  if (exitCode && (lastError || stderr)) console.error(lastError || stderr.trim());
  process.exit(exitCode);
});
send({ id: "p1", type: "prompt", message: rest.join(" ") });
