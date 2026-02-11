#!/usr/bin/env bash
# Запуск бота и воркера: освобождает порт 10000, поднимает оба процесса в фоне.
cd "$(dirname "$0")"
lsof -ti :10000 | xargs kill -9 2>/dev/null
sleep 1
npm start &
BOT_PID=$!
npm run worker:start &
WORKER_PID=$!
echo "Бот (PID $BOT_PID) и воркер (PID $WORKER_PID) запущены."
echo "Остановить: kill $BOT_PID $WORKER_PID"
wait
