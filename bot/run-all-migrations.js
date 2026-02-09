/**
 * Выполняет все миграции для запуска без заглушек (schema → astro → detailed_analysis → prompt_templates).
 * Требуется DATABASE_URL в .env (Supabase → Settings → Database → Connection string URI, пароль подставлен).
 * Запуск: node run-all-migrations.js
 */

import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  "supabase-schema.sql",
  "supabase-migration-astro-and-columns.sql",
  "supabase-migration-detailed-analysis.sql",
  "supabase-migration-prompt-templates.sql",
];

const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!DATABASE_URL) {
  console.error("Задай DATABASE_URL в bot/.env (Supabase → Database → Connection string URI).");
  console.error("Либо выполни миграции вручную в Supabase → SQL Editor по порядку:");
  MIGRATIONS.forEach((f) => console.error("  bot/" + f));
  process.exit(1);
}

async function run() {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.connect();
    console.log("Подключение к БД: OK");
    for (const file of MIGRATIONS) {
      const path = join(__dirname, file);
      const sql = readFileSync(path, "utf8");
      await client.query(sql);
      console.log("OK:", file);
    }
    const check = await client.query("select 1 from prompt_templates limit 1").catch(() => null);
    if (check) console.log("Таблица prompt_templates доступна.");
    console.log("Все миграции выполнены. Теперь выполни: npm run seed-ideally-tuned");
  } catch (err) {
    console.error("Ошибка:", err.message);
    console.error("Проверь DATABASE_URL в .env. Либо выполни SQL вручную в Supabase → SQL Editor по порядку: bot/" + MIGRATIONS.join(", bot/"));
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
