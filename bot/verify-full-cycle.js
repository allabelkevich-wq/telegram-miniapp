/**
 * Автоматическая проверка полного цикла: env, Telegram API, Supabase, healthz.
 * Запуск: node verify-full-cycle.js
 * Выход: 0 — все проверки пройдены, 1 — есть ошибки.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();
const HEALTHZ_URL = process.env.HEALTHZ_URL || "http://127.0.0.1:10000/healthz";

const results = { ok: [], fail: [] };

function pass(name, detail = "") {
  results.ok.push(detail ? `${name}: ${detail}` : name);
}
function fail(name, detail = "") {
  results.fail.push(detail ? `${name}: ${detail}` : name);
}

// 1. Переменные окружения
if (!BOT_TOKEN) {
  fail("ENV", "BOT_TOKEN не задан");
} else {
  pass("ENV", "BOT_TOKEN задан");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  fail("ENV", "SUPABASE_URL или SUPABASE_SERVICE_KEY не заданы");
} else {
  pass("ENV", "Supabase переменные заданы");
}

// 2. Telegram Bot API
let telegramOk = false;
if (BOT_TOKEN) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok && data.result?.username) {
      pass("Telegram API", `@${data.result.username}`);
      telegramOk = true;
    } else {
      fail("Telegram API", data.description || "getMe не вернул бота");
    }
  } catch (e) {
    fail("Telegram API", e.message || "сеть/таймаут");
  }
} else {
  fail("Telegram API", "пропуск (нет BOT_TOKEN)");
}

// 3. Supabase
let supabaseOk = false;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { count, error } = await supabase
      .from("track_requests")
      .select("id", { count: "exact", head: true });
    if (error) {
      fail("Supabase", error.message);
    } else {
      pass("Supabase", `подключение OK, записей в track_requests: ${count ?? "—"}`);
      supabaseOk = true;
    }
  } catch (e) {
    fail("Supabase", e.message || "ошибка подключения");
  }
} else {
  fail("Supabase", "пропуск (нет SUPABASE_*)");
}

// 4. Healthz (бот должен быть запущен)
try {
  const res = await fetch(HEALTHZ_URL, { signal: AbortSignal.timeout(3000) });
  if (res.ok && (await res.text()).trim() === "ok") {
    pass("Healthz", "бот отвечает на " + HEALTHZ_URL);
  } else {
    fail("Healthz", `код ${res.status} или тело не 'ok'`);
  }
} catch (e) {
  if (e.name === "AbortError") {
    fail("Healthz", "таймаут (запусти бота: npm start)");
  } else {
    fail("Healthz", e.message || "бот не запущен или недоступен");
  }
}

// Итог
console.log("\n--- Автопроверка полного цикла ---\n");
results.ok.forEach((s) => console.log("  ✅", s));
results.fail.forEach((s) => console.log("  ❌", s));
console.log("");

const hasFail = results.fail.length > 0;
if (hasFail) {
  console.log("Итог: есть ошибки. Исправь их и запусти снова.");
  process.exit(1);
}
console.log("Итог: все проверки пройдены. Можно тестировать отправку заявки из Mini App.");
process.exit(0);
