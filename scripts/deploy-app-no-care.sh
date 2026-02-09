#!/bin/bash
# Отправляет актуальный public/index.html (без Заботы) на GitHub.
# После пуша GitHub Actions задеплоит новую версию на GitHub Pages (1–2 мин).
# Запуск из корня репозитория: bash scripts/deploy-app-no-care.sh

set -e
cd "$(dirname "$0")/.."

echo "Копируем index.html → public/index.html (версия без Заботы)..."
cp index.html public/index.html

echo "Проверка: в public/index.html не должно быть 'Забота'..."
if grep -q 'Забота\|careBtn\|carePage' public/index.html 2>/dev/null; then
  echo "Ошибка: в корневом index.html всё ещё есть Забота. Удали Заботу из index.html и запусти скрипт снова."
  exit 1
fi

echo "Добавляем public/index.html и bot/index.js..."
git add public/index.html bot/index.js
echo "Коммит..."
git commit -m "Приложение без Заботы; ссылка v=5 для сброса кэша" || true
echo "Пуш в main..."
git push origin main
echo "Готово. Подожди 1–2 минуты, затем открой: https://allabelkevich-wq.github.io/telegram-miniapp/?v=5"
echo "Перезапусти бота, чтобы подхватилась новая ссылка."
