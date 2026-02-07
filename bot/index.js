/**
 * YupSoul Telegram Bot
 * Принимает заявки из Mini App (sendData), сохраняет, отвечает пользователю.
 */

import { Bot } from "grammy";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || "https://allabelkevich-wq.github.io/telegram-miniapp/";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

if (!BOT_TOKEN) {
  console.error("Укажи BOT_TOKEN в .env (получить у @BotFather)");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const memoryRequests = [];

function isAdmin(telegramId) {
  return telegramId && ADMIN_IDS.includes(Number(telegramId));
}

// Сохранение заявки: в Supabase и/или в память (для админки)
async function saveRequest(data) {
  const row = {
    telegram_user_id: data.telegram_user_id,
    name: data.name || null,
    birthdate: data.birthdate || null,
    birthplace: data.birthplace || null,
    birthtime: data.birthtime || null,
    birthtime_unknown: !!data.birthtime_unknown,
    gender: data.gender || null,
    request: data.request || null,
    status: "pending",
  };
  const record = { id: null, ...row, created_at: new Date().toISOString() };
  if (supabase) {
    const { data: inserted, error } = await supabase.from("track_requests").insert(row).select("id").single();
    if (error) {
      console.error("[Supabase] Ошибка при сохранении заявки:", error.message, error.code, error.details);
      record.id = null;
    } else {
      record.id = inserted?.id ?? null;
      console.log("[Supabase] Заявка сохранена, id:", record.id);
    }
  } else {
    record.id = String(Date.now());
  }
  memoryRequests.unshift(record);
  if (memoryRequests.length > 100) memoryRequests.pop();
  console.log("[Заявка]", record.id, { name: row.name, birthdate: row.birthdate, birthplace: row.birthplace });
  return record.id;
}

async function getRequestsForAdmin(limit = 30) {
  if (supabase) {
    const { data, error } = await supabase
      .from("track_requests")
      .select("id, telegram_user_id, name, birthdate, birthplace, birthtime, birthtime_unknown, gender, request, status, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[Supabase] Ошибка при загрузке заявок для /admin:", error.message, error.code);
      return { requests: memoryRequests.slice(0, limit), dbError: true };
    }
    console.log("[Supabase] Загружено заявок для админа:", (data || []).length);
    return { requests: data || [], dbError: false };
  }
  return { requests: memoryRequests.slice(0, limit), dbError: false };
}

bot.command("start", async (ctx) => {
  const name = ctx.from?.first_name || "друг";
  await ctx.reply(
    `Привет, ${name}! 👋\n\n` +
    `Я — YupSoul. Твоя жизнь — игра.\n\n` +
    `Нажми кнопку меню ниже, чтобы открыть приложение и создать свой персональный звуковой ключ — уникальную аудиокомпозицию по твоим данным и запросу.`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✨ Открыть приложение", web_app: { url: MINI_APP_URL } }
        ]]
      }
    }
  );
});

// Данные из Mini App (кнопка «Отправить заявку» → sendData)
bot.on("message:web_app_data", async (ctx) => {
  const raw = ctx.message.web_app_data?.data;
  if (!raw) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    await ctx.reply("Не удалось прочитать данные заявки. Попробуй ещё раз из приложения.");
    return;
  }

  const {
    name,
    birthdate,
    birthplace,
    birthtime,
    birthtimeUnknown,
    gender,
    request: userRequest,
    initData
  } = payload;

  const telegramUserId = ctx.from?.id;
  const requestId = await saveRequest({
    telegram_user_id: telegramUserId,
    name: name || "",
    birthdate: birthdate || "",
    birthplace: birthplace || "",
    birthtime: birthtime || null,
    birthtime_unknown: !!birthtimeUnknown,
    gender: gender || "",
    request: userRequest || "",
  });

  console.log("[Заявка]", requestId ?? "(не сохранено)", { name, birthdate, birthplace, gender, request: (userRequest || "").slice(0, 50) });

  await ctx.reply(
    "✅ Заявка принята!\n\n" +
    "Твой персональный звуковой ключ будет создан. Как только он будет готов — пришлю его сюда в чат. Ожидай уведомление."
  );
});

bot.command("admin_check", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  try {
    if (!supabase) {
      await ctx.reply("Supabase не настроен (нет SUPABASE_URL/SUPABASE_SERVICE_KEY в .env).");
      return;
    }
    const { count, error } = await supabase.from("track_requests").select("id", { count: "exact", head: true });
    if (error) {
      await ctx.reply("Ошибка подключения к Supabase:\n" + error.message + "\n\nПроверь: 1) Таблица track_requests создана (SQL из bot/supabase-schema.sql). 2) Ключ service_role верный. 3) Если используешь новый ключ (sb_secret_) — попробуй Legacy service_role в Supabase → Project Settings → API.");
      return;
    }
    await ctx.reply("Подключение к Supabase: OK.\nВ таблице track_requests записей: " + (count ?? 0) + ".\n\nЕсли 0 — отправь заявку из приложения и снова напиши /admin.");
  } catch (e) {
    await ctx.reply("Ошибка: " + (e && e.message ? e.message : String(e)));
  }
});

bot.command("admin", async (ctx) => {
  try {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply("У тебя нет доступа к этому разделу.");
      return;
    }
    await ctx.reply("Проверяю заявки…");
    const { requests, dbError } = await getRequestsForAdmin(30);
    if (dbError) {
      await ctx.reply("Не удалось загрузить заявки из базы. Проверь консоль бота и что таблица track_requests создана в Supabase (SQL из bot/supabase-schema.sql).");
      return;
    }
    if (!requests.length) {
      let hint = "Заявок пока нет.\n\n";
      if (supabase) {
        hint += "Проверь:\n1) Отправь тестовую заявку из приложения (меню → форма → донаты → Отправить заявку → кнопка внизу).\n2) В консоли бота при этом должна быть строка «[Supabase] Заявка сохранена» или «[Supabase] Ошибка».\n3) В Supabase → Table Editor → таблица track_requests — есть ли строки?\n\nНапиши /admin_check — покажу состояние подключения к базе.";
      } else {
        hint += "Supabase не подключён. Заявки хранятся только в памяти и пропадают после перезапуска бота.";
      }
      await ctx.reply(hint);
      return;
    }
    let text = "📋 Последние заявки:\n\n";
    for (let i = 0; i < requests.length; i++) {
      const r = requests[i];
      let dateStr = "—";
      try {
        if (r.created_at) dateStr = new Date(r.created_at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
      } catch (_) {
        dateStr = String(r.created_at || "—");
      }
      text += `━━━━━━━━━━━━━━\n`;
      text += `#${i + 1} · ${dateStr}\n`;
      text += `ID: ${r.id ?? "—"}\n`;
      text += `Имя: ${r.name ?? "—"}\n`;
      text += `Дата: ${r.birthdate ?? "—"}\n`;
      text += `Место: ${r.birthplace ?? "—"}\n`;
      text += `Время: ${r.birthtime_unknown ? "не указано" : (r.birthtime ?? "—")}\n`;
      text += `Пол: ${r.gender ?? "—"}\n`;
      text += `Запрос: ${(r.request || "").slice(0, 120)}${(r.request && r.request.length > 120) ? "…" : ""}\n`;
      text += `TG user: ${r.telegram_user_id ?? "—"}\n`;
      text += `Статус: ${r.status ?? "pending"}\n`;
    }
    text += `━━━━━━━━━━━━━━\nВсего: ${requests.length}`;
    if (text.length > 4000) {
      const chunks = [];
      for (let j = 0; j < text.length; j += 4000) chunks.push(text.slice(j, j + 4000));
      for (const chunk of chunks) await ctx.reply(chunk);
    } else {
      await ctx.reply(text);
    }
  } catch (err) {
    console.error("[admin]", err);
    await ctx.reply("Произошла ошибка при загрузке заявок. Проверь консоль бота или подключение к Supabase.").catch(() => {});
  }
});

// Регистрация команд в Telegram (чтобы /admin отображался в меню при вводе /)
const commands = [
  { command: "start", description: "Начать / открыть приложение" },
  { command: "admin", description: "Админ: список заявок" },
  { command: "admin_check", description: "Админ: проверка базы" }
];
bot.api.setMyCommands(commands).catch(() => {});
bot.api.setMyCommands(commands, { scope: { type: "all_private_chats" } }).catch(() => {});

// Для русскоязычного меню (часть клиентов показывает команды по языку)
bot.api.setMyCommands(commands, { language_code: "ru" }).catch(() => {});

// При старте выставляем Menu Button на Mini App (чтобы ссылка не слетала)
bot.api.setChatMenuButton({ menuButton: { type: "web_app", text: "✨ Открыть приложение", web_app: { url: MINI_APP_URL } } })
  .then(() => console.log("Кнопка меню установлена:", MINI_APP_URL))
  .catch((e) => console.warn("Не удалось установить кнопку меню:", e.message));

bot.start({
  onStart: async (info) => {
    console.log("Бот запущен:", info.username);
    if (ADMIN_IDS.length) {
      console.log("Админы (ID):", ADMIN_IDS.join(", "));
    } else {
      console.warn("ADMIN_TELEGRAM_IDS не задан — команда /admin недоступна.");
    }
    if (supabase) {
      console.log("Supabase: подключен, URL:", SUPABASE_URL);
      const { count, error } = await supabase.from("track_requests").select("id", { count: "exact", head: true });
      if (error) {
        console.error("Supabase: проверка таблицы track_requests — ошибка:", error.message);
        console.error("Убедись, что таблица создана (SQL из bot/supabase-schema.sql выполнен в SQL Editor).");
      } else {
        console.log("Supabase: в таблице track_requests записей:", count ?? 0);
      }
    } else {
      console.log("Supabase: не подключен (заявки только в памяти).");
    }
  }
});
