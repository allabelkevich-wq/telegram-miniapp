/**
 * Проверка окружения для запуска без заглушек.
 * Запуск: node check-env.js
 * Выход 0 — всё задано, 1 — чего-то не хватает (список в stderr).
 */

import "dotenv/config";

const required = {
  BOT_TOKEN: "токен от @BotFather",
  SUPABASE_URL: "Supabase → Project Settings → API → URL",
  SUPABASE_SERVICE_KEY: "Supabase → Project Settings → API → service_role",
};

const optional = {
  ADMIN_TELEGRAM_IDS: "админы через запятую",
  MINI_APP_URL: "URL Mini App",
  DATABASE_URL: "для npm run migrate:all (Supabase → Database → Connection URI)",
  DEEPSEEK_API_KEY: "для воркера генерации",
  SUNO_API_KEY: "для воркера генерации",
  BACKEND_URL: "реальный URL бэкенда (Suno callback, без example.com)",
  SUNO_CALLBACK_URL: "или явный URL для Suno callback",
};

const missing = [];
for (const [key, desc] of Object.entries(required)) {
  const v = process.env[key];
  if (!v || String(v).trim() === "") missing.push({ key, desc });
}

if (missing.length) {
  console.error("Для запуска без заглушек задай в .env:\n");
  missing.forEach(({ key, desc }) => console.error("  " + key + " — " + desc));
  console.error("\nСкопируй .env.example в .env и заполни значения.");
  process.exit(1);
}

console.log("OK: обязательные переменные заданы (BOT_TOKEN, SUPABASE_*)");
const unset = Object.keys(optional).filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
if (unset.length) {
  console.log("Опционально (для полного пайплайна и без заглушек):", unset.join(", "));
  if (unset.includes("DATABASE_URL")) {
    console.log("  → для миграций одной командой задай DATABASE_URL, затем: npm run migrate:all && npm run seed-ideally-tuned");
  }
  if (unset.includes("BACKEND_URL") && unset.includes("SUNO_CALLBACK_URL")) {
    console.log("  → задай BACKEND_URL (URL твоего бэкенда), чтобы Suno не использовал example.com");
  }
} else {
  console.log("Опциональные переменные заданы.");
}
process.exit(0);
