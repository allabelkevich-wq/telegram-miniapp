/**
 * Запуск миграции «Мои герои» в Supabase.
 * Нужна переменная DATABASE_URL в .env (строка подключения Postgres).
 * Взять: Supabase → Project Settings → Database → Connection string → URI.
 * Пароль заменить на пароль БД (не service_role key).
 */

import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(__dirname, "supabase-migration-master-heroes.sql");

const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!DATABASE_URL) {
  console.error("Не задан DATABASE_URL (или SUPABASE_DB_URL) в .env");
  console.error("");
  console.error("Как получить:");
  console.error("1. Supabase Dashboard → твой проект → Settings → Database");
  console.error("2. Connection string → URI");
  console.error("3. Замени [YOUR-PASSWORD] на пароль от БД (тот же, что при создании проекта)");
  console.error("4. Добавь в bot/.env: DATABASE_URL=postgresql://...");
  console.error("");
  console.error("Либо выполни миграцию вручную:");
  console.error("  Supabase → SQL Editor → New query → вставь содержимое файла:");
  console.error("  bot/supabase-migration-master-heroes.sql");
  process.exit(1);
}

const sql = readFileSync(migrationPath, "utf8");

async function run() {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.connect();
    console.log("Подключение к БД: OK");
    await client.query(sql);
    console.log("Миграция выполнена успешно.");
    const r = await client.query("select count(*) as n from information_schema.tables where table_schema = 'public' and table_name in ('app_users', 'clients')");
    const n = parseInt(r.rows[0]?.n ?? "0", 10);
    console.log("Таблицы app_users, clients: " + n + " из 2 созданы/проверены.");
    const col = await client.query("select column_name from information_schema.columns where table_name = 'track_requests' and column_name = 'client_id'");
    console.log("Колонка track_requests.client_id: " + (col.rows.length ? "есть" : "нет"));
  } catch (err) {
    console.error("Ошибка:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
