#!/usr/bin/env bash
# Синхронизация public/ → bot/public/ и при необходимости commit + push.
# Чтобы обновы Mini App всегда попадали в деплой с первого раза.
#
# Использование:
#   ./scripts/sync-and-deploy-miniapp.sh              — только копировать и git add
#   ./scripts/sync-and-deploy-miniapp.sh "описание"   — копировать, commit, push

set -e
cd "$(dirname "$0")/.."

echo "[sync] public/index.html → bot/public/"
cp public/index.html bot/public/

if [ -d "public/assets/icons" ]; then
  echo "[sync] public/assets/icons → bot/public/assets/"
  mkdir -p bot/public/assets
  cp -r public/assets/icons bot/public/assets/
fi

git add public/index.html bot/public/index.html
if [ -d "public/assets/icons" ]; then
  git add bot/public/assets/icons 2>/dev/null || true
fi

if [ -n "$1" ]; then
  if git diff --staged --quiet 2>/dev/null; then
    echo "[deploy] Нет изменений для коммита."
    exit 0
  fi
  git commit -m "$1"
  git push origin main
  echo "[deploy] Готово. Дождись сборки Render (2–5 мин), затем закрой и снова открой Mini App в Telegram."
else
  echo "[sync] Готово. Файлы добавлены в индекс. Сделай commit и push вручную или запусти скрипт с сообщением: ./scripts/sync-and-deploy-miniapp.sh \"описание\""
fi
