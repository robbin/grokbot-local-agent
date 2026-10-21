#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -f monitor.pid ] && kill "$(cat monitor.pid)" 2>/dev/null && echo "已停止 $(cat monitor.pid)"; rm -f monitor.pid
