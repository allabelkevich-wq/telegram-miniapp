/**
 * YupSoul Telegram Bot
 * Принимает заявки из Mini App (sendData), сохраняет, отвечает пользователю.
 * HTTP API для «Мои герои» (тариф Мастер).
 */

import { Bot } from "grammy";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createHeroesRouter, getOrCreateAppUser } from "./heroesApi.js";
import "dotenv/config";

// #region agent log
function _dbg(loc, msg, data, hyp) {
  fetch("http://127.0.0.1:7242/ingest/3d8a5f16-8394-4bc8-bad3-0e950acbd108", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: loc, message: msg, data: data || {}, timestamp: Date.now(), hypothesisId: hyp || "" }) }).catch(() => {});
}
// #endregion

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_BASE = (process.env.MINI_APP_URL || "https://allabelkevich-wq.github.io/telegram-miniapp/").replace(/\?.*$/, "").replace(/\/$/, "");
const MINI_APP_URL = MINI_APP_BASE + "?v=6";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = process.env.PORT || process.env.HEROES_API_PORT || "10000";
const HEROES_API_PORT = parseInt(PORT, 10);
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

// Сохранение заявки: в Supabase и/или в память (для админки). Поддержка client_id (тариф Мастер).
async function saveRequest(data) {
  if (!data.telegram_user_id) {
    // #region agent log
    _dbg("index.js:saveRequest", "no telegram_user_id", {}, "C");
    // #endregion
    console.error("[Supabase] saveRequest: нет telegram_user_id");
    return null;
  }
  const emptyToNull = (v) => (v === "" || v == null ? null : v);
  let row = {
    telegram_user_id: data.telegram_user_id,
    name: emptyToNull(data.name),
    birthdate: emptyToNull(data.birthdate),
    birthplace: emptyToNull(data.birthplace),
    birthtime: emptyToNull(data.birthtime),
    birthtime_unknown: !!data.birthtime_unknown,
    gender: emptyToNull(data.gender),
    language: emptyToNull(data.language),
    request: emptyToNull(data.request),
    status: "pending",
  };
  if (data.client_id && supabase) {
    const { data: client, error: clientErr } = await supabase.from("clients").select("name, birth_date, birth_time, birth_place, birthtime_unknown, gender").eq("id", data.client_id).maybeSingle();
    if (!clientErr && client) {
      row = { ...row, client_id: data.client_id, name: client.name ?? row.name, birthdate: client.birth_date ?? row.birthdate, birthtime: client.birth_time ?? row.birthtime, birthplace: client.birth_place ?? row.birthplace, birthtime_unknown: !!client.birthtime_unknown, gender: client.gender ?? row.gender };
    }
  }
  const record = { id: null, ...row, created_at: new Date().toISOString() };
  if (supabase) {
    // #region agent log
    _dbg("index.js:saveRequest", "before insert", { hasSupabase: true, rowKeys: Object.keys(row), birthdateType: typeof row.birthdate }, "C");
    // #endregion
    const { data: inserted, error } = await supabase.from("track_requests").insert(row).select("id").single();
    if (error) {
      // #region agent log
      _dbg("index.js:saveRequest", "insert error", { errorMessage: error.message, code: error.code }, "C");
      // #endregion
      console.error("[Supabase] Ошибка при сохранении заявки:", error.message, error.code, error.details);
      record.id = null;
    } else {
      record.id = inserted?.id ?? null;
      // #region agent log
      _dbg("index.js:saveRequest", "insert ok", { id: record.id }, "C");
      // #endregion
      console.log("[Supabase] Заявка сохранена, id:", record.id, row.client_id ? `(для героя ${row.client_id})` : "");
    }
  } else {
    // #region agent log
    _dbg("index.js:saveRequest", "no supabase, memory only", { id: record.id }, "C");
    // #endregion
    record.id = String(Date.now());
  }
  memoryRequests.unshift(record);
  if (memoryRequests.length > 100) memoryRequests.pop();
  console.log("[Заявка]", record.id, { name: row.name, birthdate: row.birthdate, birthplace: row.birthplace });
  return record.id;
}

const ADMIN_FETCH_TIMEOUT_MS = 8000;

async function getRequestsForAdmin(limit = 30) {
  if (!supabase) {
    return { requests: memoryRequests.slice(0, limit), dbError: false };
  }
  const fetchPromise = (async () => {
    const { data, error } = await supabase
      .from("track_requests")
      .select("id, telegram_user_id, name, birthdate, birthplace, birthtime, birthtime_unknown, gender, language, request, status, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    return { data, error };
  })();
  const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ADMIN_FETCH_TIMEOUT_MS));
  try {
    const { data, error } = await Promise.race([fetchPromise, timeoutPromise]);
    if (error) {
      // #region agent log
      _dbg("index.js:getRequestsForAdmin", "fetch error", { errorMessage: error.message }, "D");
      // #endregion
      console.error("[Supabase] Ошибка заявок /admin:", error.message);
      return { requests: memoryRequests.slice(0, limit), dbError: true };
    }
    // #region agent log
    _dbg("index.js:getRequestsForAdmin", "fetch ok", { count: (data || []).length }, "D");
    // #endregion
    console.log("[Supabase] Заявок для админа:", (data || []).length);
    return { requests: data || [], dbError: false };
  } catch (e) {
    // #region agent log
    _dbg("index.js:getRequestsForAdmin", "race catch", { message: e?.message }, "D");
    // #endregion
    if (e?.message === "timeout") console.error("[Supabase] Таймаут заявок /admin");
    else console.error("[Supabase] getRequestsForAdmin:", e?.message || e);
    return { requests: memoryRequests.slice(0, limit), dbError: true };
  }
}

bot.command("start", async (ctx) => {
  const name = ctx.from?.first_name || "друг";
  const text =
    `Привет, ${name}! 👋\n\n` +
    `Я — YupSoul. Твоя жизнь — игра.\n\n` +
    `Нажми кнопку меню ниже, чтобы открыть приложение и создать свой персональный звуковой ключ — уникальную аудиокомпозицию по твоим данным и запросу.`;
  const replyMarkup = {
    reply_markup: {
      inline_keyboard: [[
        { text: "✨ Открыть приложение", web_app: { url: MINI_APP_URL } }
      ]]
    }
  };
  try {
    const replyPromise = ctx.reply(text, replyMarkup);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("reply_timeout")), 15000)
    );
    await Promise.race([replyPromise, timeout]);
  } catch (e) {
    console.error("[start] Ошибка ответа:", e?.message || e);
    try {
      await ctx.reply("Привет! Открой приложение по кнопке меню слева от поля ввода.");
    } catch (e2) {
      console.error("[start] Fallback reply failed:", e2?.message);
    }
  }
});

// Данные из Mini App (кнопка «Отправить заявку» → sendData)
bot.on("message:web_app_data", async (ctx) => {
  const raw = ctx.message.web_app_data?.data;
  // #region agent log
  _dbg("index.js:web_app_data", "web_app_data received", { rawLength: raw?.length ?? 0, hasFrom: !!ctx.from, fromId: ctx.from?.id }, "A");
  // #endregion
  console.log("[Заявка] Получены web_app_data, длина:", raw?.length || 0);
  if (!raw) {
    await ctx.reply("Не получил данные заявки. Нажми в приложении кнопку «Отправить заявку во Вселенную» внизу экрана.");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    // #region agent log
    _dbg("index.js:web_app_data", "JSON parse failed", { error: e.message }, "B");
    // #endregion
    console.error("[Заявка] Ошибка парсинга JSON:", e.message);
    await ctx.reply("Не удалось прочитать данные заявки. Попробуй ещё раз из приложения.");
    return;
  }
  // #region agent log
  _dbg("index.js:web_app_data", "payload parsed", { keys: Object.keys(payload || {}), hasName: !!payload?.name, hasBirthdate: !!payload?.birthdate }, "B");
  // #endregion

  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    console.error("[Заявка] Нет ctx.from.id");
    await ctx.reply("Ошибка: не удалось определить пользователя. Закрой приложение и открой снова из чата с ботом.");
    return;
  }

  await ctx.reply("⏳ Получил заявку, сохраняю…");

  try {
  const {
    name,
    birthdate,
    birthplace,
    birthtime,
    birthtimeUnknown,
    gender,
    language,
    request: userRequest,
    clientId,
  } = payload;

  let requestId;
  try {
    requestId = await saveRequest({
    telegram_user_id: telegramUserId,
    name: name || "",
    birthdate: birthdate || "",
    birthplace: birthplace || "",
    birthtime: birthtime || null,
    birthtime_unknown: !!birthtimeUnknown,
    gender: gender || "",
    language: language || null,
    request: userRequest || "",
    client_id: clientId || null,
  });
  } catch (err) {
    console.error("[Заявка] Ошибка saveRequest:", err?.message || err);
    await ctx.reply("Произошла ошибка при сохранении. Попробуй ещё раз или напиши в поддержку.");
    return;
  }

  if (!requestId) {
    await ctx.reply("Не удалось сохранить заявку. Попробуй позже или напиши в поддержку.");
    console.error("[Заявка] Ошибка сохранения (saveRequest вернул null)", { name, birthdate, birthplace });
    return;
  }

  console.log("[Заявка]", requestId, { name, birthdate, birthplace, gender, request: (userRequest || "").slice(0, 50) });

  if (supabase && birthdate && birthplace) {
    import("./workerAstro.js").then(({ computeAndSaveAstroSnapshot }) =>
      computeAndSaveAstroSnapshot(supabase, requestId)
        .then((r) => {
          if (r.ok) console.log("[Астро] Снапшот сохранён для заявки", requestId);
          else console.warn("[Астро]", requestId, r.error);
        })
        .catch((e) => console.warn("[Астро] Ошибка для заявки", requestId, e.message))
    );
  }

  await ctx.reply(
    "✅ Заявка принята!\n\n" +
    "Твой персональный звуковой ключ будет создан. Как только он будет готов — пришлю его сюда в чат. Ожидай уведомление.\n\n" +
    "Детальную расшифровку натальной карты можно запросить командой /get_analysis после оплаты."
  );

  // Уведомление админам в личку о новой заявке (приходит в чат с ботом)
  if (ADMIN_IDS.length) {
    const requestPreview = (userRequest || "").trim().slice(0, 150);
    const adminText =
      "🔔 Новая заявка\n\n" +
      `Имя: ${name || "—"}\n` +
      `Язык: ${language || "—"}\n` +
      `Дата: ${birthdate || "—"} · Место: ${(birthplace || "—").slice(0, 40)}${(birthplace || "").length > 40 ? "…" : ""}\n` +
      `Запрос: ${requestPreview}${(userRequest || "").length > 150 ? "…" : ""}\n\n` +
      `ID заявки: ${requestId}\n` +
      `TG user: ${telegramUserId}`;
    console.log("[Уведомление] Отправляю админам:", ADMIN_IDS.join(", "));
    for (const adminId of ADMIN_IDS) {
      bot.api
        .sendMessage(adminId, adminText)
        .then(() => console.log("[Уведомление] Доставлено админу", adminId))
        .catch((e) => console.warn("[Уведомление админу]", adminId, e.message));
    }
  }
  } catch (err) {
    console.error("[Заявка] Необработанная ошибка в обработчике web_app_data:", err?.message || err);
    await ctx.reply("Произошла ошибка. Попробуй ещё раз или напиши в поддержку.").catch(() => {});
  }
});

// Расшифровка карты только после оплаты (docs/ALGORITHM.md)
async function sendAnalysisIfPaid(ctx) {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId || !supabase) return;
  let row;
  try {
    const { data, error } = await supabase
      .from("track_requests")
      .select("id, detailed_analysis, analysis_paid")
      .eq("telegram_user_id", telegramUserId)
      .eq("status", "completed")
      .not("detailed_analysis", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    row = data;
  } catch (e) {
    if (e?.message?.includes("column") && e?.message?.includes("does not exist")) {
      await ctx.reply("Функция детальной расшифровки подключается. Выполни миграцию bot/supabase-migration-detailed-analysis.sql в Supabase.");
      return;
    }
    await ctx.reply("Не удалось загрузить расшифровку. Попробуй позже.");
    return;
  }
  if (!row?.detailed_analysis) {
    await ctx.reply("У тебя пока нет готовой расшифровки натальной карты. Сначала дождись готовой песни по заявке — затем можно запросить детальный анализ (после оплаты).");
    return;
  }
  if (!row.analysis_paid) {
    await ctx.reply("Детальная расшифровка твоей карты готова, но доступна после оплаты. Напиши админу бота или используй реквизиты из приложения — после оплаты тебе откроют расшифровку.");
    return;
  }
  const TELEGRAM_MAX = 4096;
  const text = String(row.detailed_analysis || "").trim();
  if (!text) {
    await ctx.reply("Текст расшифровки пуст. Обратись к админу.");
    return;
  }
  if (text.length <= TELEGRAM_MAX) {
    await ctx.reply("📜 Твоя детальная расшифровка натальной карты:\n\n" + text);
    return;
  }
  await ctx.reply("📜 Твоя детальная расшифровка (несколько сообщений):");
  for (let i = 0; i < text.length; i += TELEGRAM_MAX - 50) {
    await ctx.reply(text.slice(i, i + TELEGRAM_MAX - 50));
  }
}

bot.command("get_analysis", sendAnalysisIfPaid);
bot.hears(/^(расшифровка|получить расшифровку|детальный анализ)$/i, sendAnalysisIfPaid);

bot.command("admin_check", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const send = (msg) => ctx.reply(msg).catch((e) => console.error("[admin_check] send:", e));
  try {
    if (!supabase) {
      await send("Supabase не настроен (нет SUPABASE_URL/SUPABASE_SERVICE_KEY в .env).");
      return;
    }
    const countPromise = supabase.from("track_requests").select("id", { count: "exact", head: true });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000));
    const result = await Promise.race([countPromise, timeoutPromise]);
    const { count, error } = result;
    if (error) {
      await send("Ошибка Supabase: " + error.message + "\n\nПроверь таблицу track_requests и service_role ключ в Supabase → API.");
      return;
    }
    await send("Подключение к Supabase: OK.\nВ таблице track_requests записей: " + (count ?? 0) + ".\n\nЕсли 0 — отправь заявку из приложения, затем /admin.");
  } catch (e) {
    const msg = e?.message === "timeout" ? "Таймаут подключения к Supabase. Проверь сеть и доступность Supabase." : ("Ошибка: " + (e?.message || String(e)));
    await send(msg);
  }
});

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const ADMIN_CHUNK_SIZE = TELEGRAM_MAX_MESSAGE_LENGTH - 100;

function sendLongMessage(ctx, text) {
  const chatId = ctx.chat?.id;
  if (!chatId) return Promise.resolve();
  const sendOne = (msg) => bot.api.sendMessage(chatId, msg || "—").catch((e) => console.error("[admin] chunk:", e?.message));
  if (!text || text.length <= ADMIN_CHUNK_SIZE) {
    return sendOne(text);
  }
  const chunks = [];
  for (let j = 0; j < text.length; j += ADMIN_CHUNK_SIZE) {
    chunks.push(text.slice(j, j + ADMIN_CHUNK_SIZE));
  }
  return chunks.reduce((prev, chunk) => prev.then(() => sendOne(chunk)), Promise.resolve());
}

bot.command("admin", async (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  console.log("[admin] Команда от chatId=" + chatId + " userId=" + userId + " isAdmin=" + isAdmin(userId));

  const send = (msg) => {
    if (!chatId) return Promise.resolve();
    return bot.api.sendMessage(chatId, msg).catch((e) => console.error("[admin] sendMessage:", e?.message));
  };

  try {
    if (!isAdmin(userId)) {
      await send("У тебя нет доступа к этому разделу. Твой ID: " + (userId || "?") + ". Добавь его в ADMIN_TELEGRAM_IDS в .env бота.");
      return;
    }

    const sent = await send("Проверяю заявки…");
    if (!sent) console.warn("[admin] Не удалось отправить «Проверяю заявки…»");

    const { requests, dbError } = await getRequestsForAdmin(30);

    if (dbError) {
      await send(
        "Не удалось загрузить заявки из базы (таймаут или ошибка Supabase).\n\nНапиши /admin_check — проверка подключения к базе."
      );
      return;
    }
    if (!requests.length) {
      const hint = supabase
        ? "Заявок пока нет.\n\nОтправь заявку из приложения (меню → форма → оплата → Отправить заявку). Затем снова /admin. Или /admin_check."
        : "Заявок пока нет. Supabase не подключён — заявки только в памяти.";
      await send(hint);
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
      text += `#${i + 1} · ${dateStr}\n`;
      text += `Имя: ${r.name ?? "—"} · Дата: ${r.birthdate ?? "—"}\n`;
      text += `Место: ${r.birthplace ?? "—"}\n`;
      text += `Запрос: ${(r.request || "").slice(0, 100)}${(r.request && r.request.length > 100) ? "…" : ""}\n`;
      text += `Язык: ${r.language ?? "—"} · TG: ${r.telegram_user_id ?? "—"} · ${r.status ?? "—"}\n\n`;
    }
    text += `Всего: ${requests.length}`;
    await sendLongMessage(ctx, text);
  } catch (err) {
    console.error("[admin] Ошибка:", err?.message || err);
    await send("Ошибка при загрузке заявок. Смотри консоль бота.").catch(() => {});
  }
});

// Регистрация команд в Telegram (меню бота)
const commands = [
  { command: "start", description: "Начать / открыть приложение" },
  { command: "get_analysis", description: "Расшифровка карты (после оплаты)" },
  { command: "admin", description: "Админ: список заявок" },
  { command: "admin_check", description: "Админ: проверка базы" },
];
bot.api.setMyCommands(commands).catch(() => {});
bot.api.setMyCommands(commands, { scope: { type: "all_private_chats" } }).catch(() => {});

// Для русскоязычного меню (часть клиентов показывает команды по языку)
bot.api.setMyCommands(commands, { language_code: "ru" }).catch(() => {});

// При старте выставляем Menu Button на Mini App (чтобы ссылка не слетала)
bot.api.setChatMenuButton({ menuButton: { type: "web_app", text: "✨ Открыть приложение", web_app: { url: MINI_APP_URL } } })
  .then(() => console.log("Кнопка меню установлена:", MINI_APP_URL))
  .catch((e) => console.warn("Не удалось установить кнопку меню:", e.message));

// HTTP: сначала слушаем порт (для Render health check), потом подключаем API и бота
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) =>
  res.status(200).set("Content-Type", "text/html; charset=utf-8").send(
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>YupSoul Bot</title></head><body><p>YupSoul Bot работает.</p><p>Проверка: <a href=\"/healthz\">/healthz</a></p><p>Приложение открывай из Telegram — кнопка меню бота.</p></body></html>"
  )
);

app.post("/suno-callback", express.json(), (req, res) => {
  res.status(200).send("ok");
  const taskId = req.body?.data?.taskId || req.body?.taskId;
  if (taskId) console.log("[Suno callback] taskId:", taskId, "stage:", req.body?.data?.stage || req.body?.stage);
});

async function onBotStart(info) {
  console.log("Бот запущен:", info.username);
  if (ADMIN_IDS.length) console.log("Админы (ID):", ADMIN_IDS.join(", "));
  else console.warn("ADMIN_TELEGRAM_IDS не задан — команда /admin недоступна.");
  if (supabase) {
    console.log("Supabase: подключен, URL:", SUPABASE_URL);
    const { count, error } = await supabase.from("track_requests").select("id", { count: "exact", head: true });
    if (error) console.error("Supabase: ошибка таблицы track_requests:", error.message);
    else console.log("Supabase: в таблице track_requests записей:", count ?? 0);
  } else console.log("Supabase: не подключен (заявки только в памяти).");
}

if (process.env.RENDER_HEALTHZ_FIRST) {
  app.use("/api", createHeroesRouter(supabase, BOT_TOKEN));
  globalThis.__EXPRESS_APP__ = app;
  bot.start({ onStart: onBotStart }).catch((err) => console.error("Ошибка запуска бота:", err?.message || err));
} else {
  console.log("[HTTP] Слушаю порт", HEROES_API_PORT);
  app.use("/api", createHeroesRouter(supabase, BOT_TOKEN));
  app.listen(HEROES_API_PORT, "0.0.0.0", () => {
    console.log("[HTTP] Порт открыт:", HEROES_API_PORT);
    bot.start({ onStart: onBotStart }).catch((err) => console.error("Ошибка запуска бота:", err?.message || err));
  });
}
