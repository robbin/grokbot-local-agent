#!/usr/bin/env bash
# 启动 pi-telegram-monitor（nohup 常驻，PID 文件防重复）
cd "$(dirname "$0")"
PID=monitor.pid
if [ -f $PID ] && kill -0 "$(cat $PID)" 2>/dev/null; then echo "已在运行 PID $(cat $PID)"; exit 0; fi
[ -z "$TELEGRAM_BOT_TOKEN" ] && { echo "缺少 TELEGRAM_BOT_TOKEN 环境变量"; exit 1; }
[ -z "$TELEGRAM_CHAT_ID" ] && { echo "缺少 TELEGRAM_CHAT_ID 环境变量"; exit 1; }
setsid nohup node monitor.js >> monitor.log 2>&1 &
echo $! > $PID; echo "已启动 PID $!"
