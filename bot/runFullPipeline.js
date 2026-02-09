/**
 * Автономный пайплайн (docs/ALGORITHM.md):
 * Одна заявка pending → при необходимости расчёт натальной карты (геокод + астро) →
 * DeepSeek (анализ + 2 стиля + лирика + название) → сохранение анализа (доступен после оплаты) →
 * Suno → отправка аудио пользователю в Telegram.
 *
 * Запуск: node runFullPipeline.js
 * Крон: например каждые 2–5 минут для обработки очереди.
 *
 * Требует: .env с BOT_TOKEN, SUPABASE_*, DEEPSEEK_API_KEY, SUNO_API_KEY.
 */

import "dotenv/config";
import { runOnceWithAstro } from "./workerGenerate.js";

runOnceWithAstro()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[FullPipeline] Ошибка:", e);
    process.exit(1);
  });
