/**
 * Добавляет DATABASE_URL в .env, если его ещё нет (или значение — плейсхолдер).
 * Хост берётся из SUPABASE_URL (если есть), иначе — дефолтный. Пароль подставить вручную.
 * Запуск: node ensure-database-url.js
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, ".env");

const PLACEHOLDERS = ["ТВОЙ_ПАРОЛЬ", "YOUR_PASSWORD", "ЗАМЕНИ_НА_ПАРОЛЬ", "ЗАМЕНИ_ПАРОЛЬ", "ПАРОЛЬ_БД", "ЗАМЕНИ_ПАРОЛЬ_БД"];

function hasRealDatabaseUrl(content) {
  const match = content.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m);
  if (!match) return false;
  const value = (match[1] || "").trim();
  if (!value) return false;
  if (PLACEHOLDERS.some((p) => value.includes(p))) return false;
  return value.startsWith("postgresql://") || value.startsWith("postgres://");
}

function getDbHost() {
  const u = process.env.SUPABASE_URL || "";
  const m = u.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (m) return `db.${m[1]}.supabase.co`;
  return "db.fcnyhsmhvmliojonswcv.supabase.co";
}

const dbHost = getDbHost();
const defaultLine =
  "# Пароль взять: Supabase → Settings → Database → Database password\n" +
  `DATABASE_URL=postgresql://postgres:ЗАМЕНИ_ПАРОЛЬ_БД@${dbHost}:5432/postgres`;

if (!existsSync(envPath)) {
  console.error("Файл bot/.env не найден. Скопируй .env.example в .env и заполни BOT_TOKEN, SUPABASE_*.");
  process.exit(1);
}

let content = readFileSync(envPath, "utf8");
if (hasRealDatabaseUrl(content)) {
  console.log("DATABASE_URL уже задан в .env.");
  process.exit(0);
}

if (/^\s*DATABASE_URL\s*=/m.test(content)) {
  console.log("В .env есть DATABASE_URL с плейсхолдером — замени пароль на реальный (Supabase → Database → Database password).");
  process.exit(0);
}

content = content.trimEnd();
if (!content.endsWith("\n")) content += "\n";
content += "\n" + defaultLine + "\n";
writeFileSync(envPath, content, "utf8");
console.log("В .env добавлена строка DATABASE_URL. Открой bot/.env и замени ЗАМЕНИ_ПАРОЛЬ_БД на пароль из Supabase → Settings → Database → Database password.");
console.log("Затем выполни: npm run setup:db");
