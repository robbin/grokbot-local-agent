#!/usr/bin/env node
// Pi Agent 会话 -> Telegram 单向推送（只发不收）
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN 未设置，退出'); process.exit(1); }
if (!CHAT) { console.error('TELEGRAM_CHAT_ID 未设置，退出'); process.exit(1); }
const PI_HOME = process.env.PI_HOME || path.join(os.homedir(), '.pi');
const DIRS = [
  { dir: path.join(PI_HOME, 'agent/sessions/bot'), kind: 'session', label: 'pi-run' },
  { dir: path.join(PI_HOME, 'agent/sessions/tasks'), kind: 'session', label: 'pi-task' },
  { dir: path.join(PI_HOME, 'tasks'), kind: 'events', label: 'task-events' },
];
const POLL_MS = 1500, EDIT_MIN_MS = 2000, MAX_STEPS = 25, MAX_LEN = 3900;
const IDLE_DONE_MS = +(process.env.PI_TG_IDLE_DONE_MS || 30000);   // 最后回复后无更新
const IDLE_STALE_MS = +(process.env.PI_TG_IDLE_STALE_MS || 600000); // 任意状态长时间无更新
const log = (...a) => console.log(new Date().toISOString(), ...a);

function redact(s) {
  return String(s)
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_BOT_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/g, '$1_[REDACTED]')
    .replace(/\b(xox[abpr]-|AKIA|AIza|re_)[A-Za-z0-9_-]{10,}/g, '$1[REDACTED]')
    .replace(/(Bearer|Basic|token)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/((?:api[_-]?key|secret|password|passwd|token|auth)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]')
    .replace(/\b[a-fA-F0-9]{32,}\b/g, '[REDACTED_HEX]')
    .replace(/\b[A-Za-z0-9+\/_-]{40,}={0,2}/g, m => /[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '[REDACTED_B64]' : m);
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Telegram（只调用 sendMessage / editMessageText）----
async function tg(method, body, tries = 0) {
  let res, j;
  try {
    res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    j = await res.json();
  } catch (e) {
    if (tries < 4) { await sleep(2000 * (tries + 1)); return tg(method, body, tries + 1); }
    log(`${method} 网络错误`, e.name); return { ok: false };
  }
  if (j.ok) return j;
  if (j.error_code === 429 && tries < 6) {
    const w = ((j.parameters && j.parameters.retry_after) || 3) * 1000 + 500;
    log(`${method} 429，等待 ${w}ms`); await sleep(w); return tg(method, body, tries + 1);
  }
  if (/message is not modified/.test(j.description || '')) return { ok: true, result: null };
  log(`${method} 失败 ${j.error_code} ${short(j.description, 120)}`);
  return j;
}

// 最终回复全文：遮蔽后按长度拆分成多条“结果”消息
async function sendResults(st) {
  while (st.results.length) {
    const txt = redact(st.results.shift());
    const chunks = []; let rest = txt;
    while (rest.length) { let cut = rest.length <= 3500 ? rest.length : rest.lastIndexOf('\n', 3500);
      if (cut < 1500) cut = 3500; chunks.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, ''); }
    for (let i = 0; i < chunks.length; i++) {
      const head = `<b>📋 结果 [${st.label}] ${esc(st.name)}</b>${chunks.length > 1 ? `（${i + 1}/${chunks.length}）` : ''}\n\n`;
      const r = await tg('sendMessage', { chat_id: CHAT, text: head + esc(chunks[i]), parse_mode: 'HTML', disable_web_page_preview: true });
      if (r.ok) log(`result sendMessage ok ${st.name} part ${i + 1}/${chunks.length} len=${chunks[i].length}`);
      await sleep(1100);
    }
  }
}

// ---- 会话状态 ----
const streams = new Map(); // file -> state
function newState(file, kind, label) {
  return { file, kind, label, offset: 0, buf: '', name: path.basename(file), steps: [], status: '运行中',
    msgId: null, part: 1, lastChange: Date.now(), lastEdit: 0, dirty: false, done: false, finalSeen: false, tokens: 0, results: [] };
}
function addStep(st, icon, text) { st.steps.push(`${icon} ${esc(redact(text))}`); st.dirty = true; st.lastChange = Date.now(); }

function handleSession(st, o) {
  if (o.type === 'session_info' && o.name) st.name = o.name;
  else if (o.type === 'session' && o.id) st.name = st.name.includes('_') ? o.id : st.name;
  if (o.type !== 'message' || !o.message) return;
  const m = o.message, c = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
  if (m.role === 'user') { st.finalSeen = false; st.status = '运行中';
    addStep(st, '👤', '指令：' + short(c.filter(x => x.type === 'text').map(x => x.text).join(' '), 200)); }
  else if (m.role === 'assistant') {
    if (m.usage && m.usage.totalTokens) st.tokens += m.usage.totalTokens;
    let hasTool = false;
    for (const x of c) {
      if (x.type === 'toolCall') { hasTool = true;
        const a = x.arguments || {};
        const arg = a.command ?? a.path ?? a.pattern ?? (a.queries ? a.queries.join(' | ') : null) ?? a.url ?? JSON.stringify(a);
        addStep(st, '🔧', `${x.name}: ${short(arg, 140)}`); }
      else if (x.type === 'text' && x.text.trim()) addStep(st, '🤖', short(x.text, 300));
    }
    if (m.stopReason === 'error' || m.stopReason === 'aborted') { st.status = '❌ 出错/中止'; st.dirty = true; }
    else if (!hasTool && m.stopReason === 'stop') {
      st.finalSeen = true;
      const full = c.filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
      if (full) st.results.push(full);
    }
  } else if (m.role === 'toolResult' && m.isError) {
    addStep(st, '⚠️', `${m.toolName} 出错：` + short(c.map(x => x.text || '').join(' '), 120));
  }
}
function handleEvents(st, o) {
  const t = o.type || '?';
  if (t === 'task_start') addStep(st, '▶️', '任务开始：' + short(o.text, 160));
  else if (/end|done|finish|state|exit|cancel|fail|timeout/i.test(t)) {
    addStep(st, '🏁', `${t} ${short(o.state ?? o.exit_code ?? o.text ?? '', 80)}`);
    if (/end|done|finish|exit|cancel|fail|timeout/i.test(t)) { st.status = '✅ 已结束'; st.done = true; }
  } else if (t !== 'notify') addStep(st, '·', `${t} ${short(o.text ?? '', 100)}`);
}

function render(st) {
  const head = `<b>[${st.label}] ${esc(st.name)}</b> — ${st.status}${st.part > 1 ? `（续 ${st.part}）` : ''}` +
    (st.tokens ? `\n<i>tokens≈${st.tokens}</i>` : '');
  return head + '\n\n' + (st.steps.join('\n') || '…');
}
async function flush(st, force = false) {
  if (!st.dirty && !force) return;
  if (!force && Date.now() - st.lastEdit < EDIT_MIN_MS) return;
  // 超长或步骤过多：当前消息定稿，开新消息续写
  while (st.msgId && (render(st).length > MAX_LEN || st.steps.length > MAX_STEPS)) {
    let keep = st.steps.length - 1; // 至少留最后一步给新消息
    const moved = st.steps.splice(Math.max(1, Math.min(keep, MAX_STEPS)));
    const s = st.status; st.status = '➡️ 见下一条';
    await tg('editMessageText', { chat_id: CHAT, message_id: st.msgId, text: render(st).slice(0, 4096), parse_mode: 'HTML', disable_web_page_preview: true });
    st.status = s; st.steps = moved; st.msgId = null; st.part++;
  }
  while (render(st).length > MAX_LEN && st.steps.length > 1) st.steps.shift();
  const text = render(st).slice(0, 4096);
  st.lastEdit = Date.now(); st.dirty = false;
  if (!st.msgId) {
    const r = await tg('sendMessage', { chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true });
    if (r.ok && r.result) { st.msgId = r.result.message_id; log(`sendMessage ok ${st.name} #${st.msgId}`); }
  } else {
    const r = await tg('editMessageText', { chat_id: CHAT, message_id: st.msgId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    if (r.ok) log(`editMessageText ok ${st.name} #${st.msgId} steps=${st.steps.length}`);
  }
}

function readNew(st) {
  let size; try { size = fs.statSync(st.file).size; } catch { return; }
  if (size < st.offset) st.offset = 0;
  if (size === st.offset) return;
  const fd = fs.openSync(st.file, 'r'); const b = Buffer.alloc(size - st.offset);
  fs.readSync(fd, b, 0, b.length, st.offset); fs.closeSync(fd); st.offset = size;
  st.buf += b.toString('utf8'); const lines = st.buf.split('\n'); st.buf = lines.pop();
  for (const l of lines) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    (st.kind === 'events' ? handleEvents : handleSession)(st, o); }
  if (st.done === false && st.status !== '运行中' && !st.status.startsWith('❌')) st.status = '运行中';
}

function listFiles(d) {
  try {
    if (d.kind === 'events') return fs.readdirSync(d.dir).map(x => path.join(d.dir, x, 'events.jsonl')).filter(f => fs.existsSync(f));
    return fs.readdirSync(d.dir).filter(x => x.endsWith('.jsonl')).map(x => path.join(d.dir, x));
  } catch { return []; }
}
// 启动快照：已有文件记录当前大小，不推历史；之后追加的内容才推
const known = new Map();
for (const d of DIRS) for (const f of listFiles(d)) { try { known.set(f, fs.statSync(f).size); } catch {} }
log(`启动，监听 ${DIRS.map(d => d.dir).join(', ')}；忽略已有 ${known.size} 个文件的历史内容`);

let busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    for (const d of DIRS) for (const f of listFiles(d)) {
      let st = streams.get(f);
      if (!st) {
        let size; try { size = fs.statSync(f).size; } catch { continue; }
        const base = known.get(f);
        if (base !== undefined && size === base) continue; // 旧文件无变化
        st = newState(f, d.kind, d.label);
        if (d.kind === 'events') st.name = path.basename(path.dirname(f));
        if (base !== undefined) { st.offset = base; st.name = st.name.replace(/^[^_]+_/, '').replace(/\.jsonl$/, '');
          addStep(st, 'ℹ️', '（旧会话有新追加，仅显示新内容）'); }
        streams.set(f, st); log(`发现活动流 ${d.label} ${path.basename(f)}`);
      }
      if (st.done) { // 已完成的会话若又有追加，重新激活（同一会话继续写到新消息）
        let size; try { size = fs.statSync(f).size; } catch { continue; }
        if (size === st.offset) continue;
        st.done = false; st.status = '运行中'; st.msgId = null; st.part++; st.steps = [];
      }
      readNew(st);
      const idle = Date.now() - st.lastChange;
      if (!st.done && st.kind === 'session' && st.finalSeen && idle > IDLE_DONE_MS) { st.status = '✅ 完成'; st.done = true; st.dirty = true; }
      else if (!st.done && idle > IDLE_STALE_MS) { st.status = '⏸ 长时间无更新，标记结束'; st.done = true; st.dirty = true; }
      else if (st.finalSeen && !st.done && st.status === '运行中') { st.status = '💤 已回复，等待后续'; st.dirty = true; }
      await flush(st, st.done && st.dirty);
      if (st.results.length) await sendResults(st);
    }
    for (const [f, st] of streams) if (st.done && !st.dirty && Date.now() - st.lastChange > 6 * 3600e3) { known.set(f, st.offset); streams.delete(f); } // 记住已读位置，防止清理后把旧会话当新会话重推
  } catch (e) { log('tick 错误', e.message); }
  busy = false;
}
setInterval(tick, POLL_MS);
process.on('SIGTERM', () => { log('收到 SIGTERM，退出'); process.exit(0); });
