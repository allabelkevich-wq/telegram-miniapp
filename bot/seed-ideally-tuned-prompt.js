/**
 * Загрузка «Идеально отлаженного промпта» из bot/prompts/ideally_tuned_system.txt в таблицу prompt_templates.
 * Запуск: из папки bot выполнить миграцию prompt_templates (если ещё не выполнена), затем:
 *   node seed-ideally-tuned-prompt.js
 * Требуется .env с SUPABASE_URL и SUPABASE_SERVICE_KEY.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = join(__dirname, "prompts", "ideally_tuned_system.txt");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Нужны SUPABASE_URL и SUPABASE_SERVICE_KEY в .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const name = "ideally_tuned_system_v1";
const variables = ["astro_snapshot", "name", "birthdate", "birthplace", "birthtime", "language", "request"];

async function run() {
  let body;
  try {
    body = readFileSync(promptPath, "utf8");
  } catch (e) {
    console.error("Не удалось прочитать файл промпта:", promptPath, e.message);
    process.exit(1);
  }

  const { data: existing } = await supabase
    .from("prompt_templates")
    .select("id")
    .eq("name", name)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("prompt_templates")
      .update({ body, variables, updated_at: new Date().toISOString() })
      .eq("name", name);
    if (error) {
      console.error("Ошибка обновления:", error.message);
      if ((error.message || "").toLowerCase().includes("prompt_templates") || (error.message || "").includes("schema cache")) {
        console.error("\nТаблица prompt_templates не найдена. Выполни миграции: npm run migrate:all или вручную в Supabase SQL Editor.");
      }
      process.exit(1);
    }
    console.log("Промпт «Идеально отлаженный» (ideally_tuned_system_v1) обновлён в prompt_templates.");
  } else {
    const { error } = await supabase.from("prompt_templates").insert({
      name,
      body,
      variables,
      is_active: true,
      version: 1,
    });
    if (error) {
      console.error("Ошибка вставки:", error.message);
      if ((error.message || "").toLowerCase().includes("prompt_templates") || (error.message || "").includes("schema cache")) {
        console.error("\nВыполни миграции: npm run migrate:all (в .env нужен DATABASE_URL) или вручную в Supabase → SQL Editor файлы из bot/.");
      }
      process.exit(1);
    }
    console.log("Промпт «Идеально отлаженный» (ideally_tuned_system_v1) добавлен в prompt_templates.");
  }
}

run();
