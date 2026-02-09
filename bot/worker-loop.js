/**
 * Долгоиграющий воркер для Render (Background Worker).
 * Раз в N минут обрабатывает одну заявку (астро → DeepSeek → Suno → отправка).
 * Запуск: node worker-loop.js
 * Интервал: WORKER_INTERVAL_MS (по умолчанию 300000 = 5 мин).
 */

import "dotenv/config";
import { runOnceWithAstro } from "./workerGenerate.js";

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS) || 5 * 60 * 1000;

if (!process.env.DEEPSEEK_API_KEY || !process.env.SUNO_API_KEY) {
  console.warn("[WorkerLoop] В .env задай DEEPSEEK_API_KEY и SUNO_API_KEY — иначе генерация текста и музыки не заработает.");
}

async function tick() {
  try {
    await runOnceWithAstro();
  } catch (e) {
    console.error("[WorkerLoop] Ошибка:", e?.message || e);
  }
}

console.log("[WorkerLoop] Запуск. Пайплайн: заявка → астро (Swiss Ephemeris) → DeepSeek (текст) → Suno (аудио) → отправка в Telegram. Интервал:", INTERVAL_MS / 1000, "с");
tick();
setInterval(tick, INTERVAL_MS);
