/**
 * YupSoul Telegram Bot
 * Принимает заявки из Mini App (sendData), сохраняет, отвечает пользователю.
 * HTTP API для «Мои герои» (тариф Мастер).
 */

import { Bot, webhookCallback } from "grammy";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createHeroesRouter, getOrCreateAppUser, validateInitData } from "./heroesApi.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_LOG_PATH = path.join(process.cwd(), ".cursor", "debug.log");
function debugLog(payload) {
  const line = JSON.stringify({ ...payload, timestamp: payload.timestamp || Date.now() });
  console.log("[debug]", line);
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
    fs.appendFileSync(DEBUG_LOG_PATH, line + "\n");
  } catch (_) {}
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_BASE = (process.env.MINI_APP_URL || "https://telegram-miniapp-six-teal.vercel.app").replace(/\?.*$/, "").replace(/\/$/, "");
const MINI_APP_URL = MINI_APP_BASE + "?v=7";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = process.env.PORT || process.env.HEROES_API_PORT || "10000";
const HEROES_API_PORT = parseInt(PORT, 10);
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => parseInt(s, 10))
  .filter((n) => !Number.isNaN(n));
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

if (!BOT_TOKEN) {
  console.error("Укажи BOT_TOKEN в .env (получить у @BotFather)");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Лог входящих апдейтов и сразу «печатает…» — чтобы сообщение не казалось «не отправленным»
bot.use(async (ctx, next) => {
  const msg = ctx.message;
  const fromId = ctx.from?.id;
  if (msg?.text) {
    console.log("[TG] msg from", fromId, ":", msg.text.slice(0, 80) + (msg.text.length > 80 ? "…" : ""));
    // #region agent log
    if (msg.text.trim().toLowerCase().startsWith("/admin")) {
      const p = { location: "index.js:middleware", message: "TG update with /admin received", data: { fromId, chatId: ctx.chat?.id, hasChat: !!ctx.chat, hasFrom: !!ctx.from }, timestamp: Date.now(), hypothesisId: "H1" };
      debugLog(p);
      fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }).catch(() => {});
    }
    // #endregion
  }
  const chatId = ctx.chat?.id;
  if (chatId) ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  return next();
});

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
    mode: (data.mode === "couple" || data.mode === "transit") ? data.mode : "single",
    person2_name: emptyToNull(data.person2_name),
    person2_birthdate: emptyToNull(data.person2_birthdate),
    person2_birthplace: emptyToNull(data.person2_birthplace),
    person2_birthtime: emptyToNull(data.person2_birthtime),
    person2_birthtime_unknown: !!data.person2_birthtime_unknown,
    person2_gender: emptyToNull(data.person2_gender),
    transit_date: emptyToNull(data.transit_date),
    transit_time: emptyToNull(data.transit_time),
    transit_location: emptyToNull(data.transit_location),
    transit_intent: emptyToNull(data.transit_intent),
  };
  if (data.client_id && supabase) {
    const { data: client, error: clientErr } = await supabase.from("clients").select("name, birth_date, birth_time, birth_place, birthtime_unknown, gender").eq("id", data.client_id).maybeSingle();
    if (!clientErr && client) {
      row = { ...row, client_id: data.client_id, name: client.name ?? row.name, birthdate: client.birth_date ?? row.birthdate, birthtime: client.birth_time ?? row.birthtime, birthplace: client.birth_place ?? row.birthplace, birthtime_unknown: !!client.birthtime_unknown, gender: client.gender ?? row.gender };
    }
  }
  const record = { id: null, ...row, created_at: new Date().toISOString() };
  if (supabase) {
    const { data: inserted, error } = await supabase.from("track_requests").insert(row).select("id").single();
    if (error) {
      console.error("[Supabase] Ошибка при сохранении заявки:", error.message, error.code, error.details);
      record.id = null;
    } else {
      record.id = inserted?.id ?? null;
      console.log("[Supabase] Заявка сохранена, id:", record.id, row.client_id ? `(для героя ${row.client_id})` : "");
    }
  } else {
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
      console.error("[Supabase] Ошибка заявок /admin:", error.message);
      return { requests: memoryRequests.slice(0, limit), dbError: true };
    }
    console.log("[Supabase] Заявок для админа:", (data || []).length);
    return { requests: data || [], dbError: false };
  } catch (e) {
    if (e?.message === "timeout") console.error("[Supabase] Таймаут заявок /admin");
    else console.error("[Supabase] getRequestsForAdmin:", e?.message || e);
    return { requests: memoryRequests.slice(0, limit), dbError: true };
  }
}

// Кнопку меню (слева от поля ввода) задаём только в @BotFather → Bot Settings → Menu Button.
// Бот НЕ вызывает setChatMenuButton — иначе перезаписывает настройку и кнопка «слетает».

bot.command("ping", async (ctx) => {
  await ctx.reply("Бот на связи. Команды работают.");
});

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
    // Сначала быстрый ответ без кнопки — убирает колесо загрузки у сообщения пользователя
    await ctx.reply(text);
    // Затем кнопка отдельным сообщением
    await ctx.reply("Открыть приложение:", replyMarkup);
  } catch (e) {
    console.error("[start] Ошибка ответа:", e?.message || e);
    try {
      await ctx.reply("Привет! Открой приложение по кнопке меню слева от поля ввода.");
    } catch (e2) {
      console.error("[start] Fallback reply failed:", e2?.message);
    }
  }
});

// Лог любых сообщений с web_app_data (если не видно [Заявка] — обновления уходят другому процессу, напр. бот на Render)
bot.on("message", (ctx, next) => {
  if (ctx.message?.web_app_data) {
    const data = ctx.message.web_app_data?.data;
    console.log("[Заявка] ⚠️ ВАЖНО: Получены web_app_data, длина:", data?.length ?? 0, "пользователь:", ctx.from?.id, "имя:", ctx.from?.first_name);
    console.log("[Заявка] Полное сообщение:", JSON.stringify(ctx.message, null, 2));
    if (data) {
      try {
        const parsed = JSON.parse(data);
        console.log("[Заявка] Предпросмотр данных:", { name: parsed.name, birthplace: parsed.birthplace, hasCoords: !!(parsed.birthplaceLat && parsed.birthplaceLon) });
      } catch (e) {
        console.warn("[Заявка] Не удалось распарсить предпросмотр:", e.message);
      }
    } else {
      console.error("[Заявка] ⚠️ КРИТИЧНО: web_app_data.data пустой или undefined!");
    }
  }
  return next();
});

// Данные из Mini App (кнопка «Отправить заявку» → sendData)
bot.on("message:web_app_data", async (ctx) => {
  console.log("[Заявка] ⚠️ ОБРАБОТЧИК АКТИВИРОВАН! message:", ctx.message ? "есть" : "нет", "web_app_data:", ctx.message?.web_app_data ? "есть" : "нет");
  const raw = ctx.message.web_app_data?.data;
  console.log("[Заявка] Обработка web_app_data, длина:", raw?.length || 0, "тип:", typeof raw);
  if (!raw) {
    console.error("[Заявка] ⚠️ КРИТИЧНО: Пустые web_app_data! ctx.message:", JSON.stringify(ctx.message, null, 2));
    await ctx.reply("Не получил данные заявки. Нажми в приложении кнопку «Отправить заявку во Вселенную» внизу экрана.");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
    console.log("[Заявка] JSON распарсен, поля:", Object.keys(payload));
  } catch (e) {
    console.error("[Заявка] Ошибка парсинга JSON:", e.message, "Сырые данные (первые 200 символов):", raw?.slice(0, 200));
    await ctx.reply("Не удалось прочитать данные заявки. Попробуй ещё раз из приложения.");
    return;
  }
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    console.error("[Заявка] Нет ctx.from.id, ctx.from:", ctx.from);
    await ctx.reply("Ошибка: не удалось определить пользователя. Закрой приложение и открой снова из чата с ботом.");
    return;
  }

  console.log("[Заявка] Пользователь:", telegramUserId, "Имя:", payload.name, "Место:", payload.birthplace, "Координаты:", payload.birthplaceLat ? `${payload.birthplaceLat}, ${payload.birthplaceLon}` : "нет");
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
    birthplaceLat,
    birthplaceLon,
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
    console.error("[Заявка] Ошибка saveRequest:", err?.message || err, err?.stack);
    await ctx.reply("Произошла ошибка при сохранении. Попробуй ещё раз или напиши в поддержку.");
    return;
  }

  if (!requestId) {
    await ctx.reply("Не удалось сохранить заявку. Попробуй позже или напиши в поддержку.");
    console.error("[Заявка] Ошибка сохранения (saveRequest вернул null)", { name, birthdate, birthplace, telegramUserId });
    return;
  }

  console.log("[Заявка] Сохранена успешно, ID:", requestId, { name, birthdate, birthplace, gender, language, request: (userRequest || "").slice(0, 50), hasCoords: !!(birthplaceLat && birthplaceLon) });

  if (supabase && birthdate && birthplace) {
    console.log(`[API] ЗАПУСКАЮ ВОРКЕР для ${requestId}`);
    (async () => {
      try {
        const module = await import("./workerSoundKey.js");
        if (typeof module.generateSoundKey !== "function") {
          throw new Error("Функция generateSoundKey не экспортирована");
        }
        await module.generateSoundKey(requestId);
        console.log(`[Воркер] Успешно завершён для ${requestId}`);
      } catch (error) {
        console.error(`[ВОРКЕР] КРИТИЧЕСКАЯ ОШИБКА для ${requestId}:`, error);
        await supabase.from("track_requests").update({
          generation_status: "failed",
          error_message: error?.message || String(error),
        }).eq("id", requestId);
      }
    })();
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
    console.log("[Уведомление] Отправляю в личку админам:", ADMIN_IDS.join(", "));
    for (const adminId of ADMIN_IDS) {
      bot.api
        .sendMessage(adminId, adminText)
        .then(() => console.log("[Уведомление] Доставлено админу (личка)", adminId))
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
  if (!telegramUserId) {
    await ctx.reply("Не удалось определить пользователя. Напиши из лички с ботом.");
    return;
  }
  if (!supabase) {
    await ctx.reply("База не подключена. Обратись к админу.");
    return;
  }
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

// Команда для админа: просмотр натальной карты по request_id
bot.command("astro", async (ctx) => {
  const userId = ctx.from?.id;
  if (!isAdmin(userId)) {
    await ctx.reply("🔒 Эта команда доступна только администраторам.");
    return;
  }
  const args = ctx.message?.text?.trim()?.split(/\s+/)?.slice(1) || [];
  if (args.length === 0) {
    await ctx.reply("Использование: /astro <request_id>\nПример: /astro abc123-def456");
    return;
  }
  const requestId = args[0];
  if (!supabase) {
    await ctx.reply("❌ База данных не настроена.");
    return;
  }
  try {
    const { data: row, error: reqErr } = await supabase
      .from("track_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();
    if (reqErr || !row) {
      await ctx.reply(`❌ Заявка с ID ${requestId} не найдена.`);
      return;
    }
    let message = `🌌 НАТАЛЬНАЯ КАРТА для заявки ${requestId}\n\n`;
    message += `👤 Имя: ${row.name || "—"}\n`;
    message += `⚧️ Пол: ${row.gender === "male" ? "Мужской" : row.gender === "female" ? "Женский" : row.gender || "—"}\n`;
    message += `📅 Дата рождения: ${row.birthdate || "—"}\n`;
    message += `📍 Место: ${row.birthplace || "—"}\n`;
    message += `🕐 Время: ${row.birthtime_unknown ? "неизвестно" : row.birthtime || "—"}\n\n`;
    if (row.astro_snapshot_id) {
      const { data: snapshot, error: snapErr } = await supabase
        .from("astro_snapshots")
        .select("snapshot_text, snapshot_json, birth_lat, birth_lon, birth_utc")
        .eq("id", row.astro_snapshot_id)
        .maybeSingle();
      if (!snapErr && snapshot) {
        message += `✨ ТЕКСТОВЫЙ АНАЛИЗ:\n${snapshot.snapshot_text || "—"}\n\n`;
        if (snapshot.snapshot_json && typeof snapshot.snapshot_json === "object") {
          const j = snapshot.snapshot_json;
          message += `📊 СТРУКТУРИРОВАННЫЕ ДАННЫЕ:\n`;
          message += `• Солнце: ${j.sun_sign ?? "—"} (дом ${j.sun_house ?? "—"})\n`;
          message += `• Луна: ${j.moon_sign ?? "—"} (дом ${j.moon_house ?? "—"})\n`;
          message += `• Асцендент: ${j.ascendant_sign ?? "—"}\n`;
          message += `• Доминантные планеты: ${Array.isArray(j.dominant_planets) ? j.dominant_planets.join(", ") : "—"}\n`;
          if (snapshot.birth_lat != null && snapshot.birth_lon != null) {
            message += `• Координаты: ${Number(snapshot.birth_lat).toFixed(4)}, ${Number(snapshot.birth_lon).toFixed(4)}\n`;
          }
          if (snapshot.birth_utc) message += `• UTC время: ${snapshot.birth_utc}\n`;
        }
      } else {
        message += `⚠️ Астро-снапшот не найден (возможно, расчёт ещё не завершён).\n`;
      }
    } else {
      message += `⚠️ Астро-снапшот не привязан к заявке (расчёт не запускался).\n`;
    }
    const chunks = message.match(/[\s\S]{1,4000}/g) || [message];
    for (const chunk of chunks) await ctx.reply(chunk);
  } catch (err) {
    console.error("[/astro] Ошибка:", err);
    await ctx.reply(`❌ Ошибка: ${err?.message || err}`);
  }
});

// Команда для админа: полный анализ и текст песни по request_id
bot.command("full_analysis", async (ctx) => {
  const userId = ctx.from?.id;
  if (!isAdmin(userId)) {
    await ctx.reply("🔒 Эта команда доступна только администраторам.");
    return;
  }
  const args = ctx.message?.text?.trim()?.split(/\s+/)?.slice(1) || [];
  if (args.length === 0) {
    await ctx.reply("Использование: /full_analysis <request_id>\nПример: /full_analysis abc123-def456");
    return;
  }
  const requestId = args[0];
  if (!supabase) {
    await ctx.reply("❌ База данных не настроена.");
    return;
  }
  try {
    const { data: row, error } = await supabase
      .from("track_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();
    if (error || !row) {
      await ctx.reply(`❌ Заявка с ID ${requestId} не найдена.`);
      return;
    }
    let message = `📄 ПОЛНЫЙ АНАЛИЗ для заявки ${requestId}\n\n`;
    message += `👤 ${row.name || "—"} | 🌍 ${row.birthplace || "—"}\n`;
    message += `🎯 Запрос: "${(row.request || "").slice(0, 200)}${(row.request || "").length > 200 ? "…" : ""}"\n\n`;
    if (row.detailed_analysis) {
      message += `🔍 ГЛУБОКИЙ АНАЛИЗ:\n${row.detailed_analysis}\n\n`;
    } else {
      message += `⚠️ Полный анализ ещё не сгенерирован\n\n`;
    }
    if (row.lyrics) {
      message += `🎵 ТЕКСТ ПЕСНИ:\n${row.lyrics}\n\n`;
    } else {
      message += `⚠️ Текст песни ещё не сгенерирован\n\n`;
    }
    message += `📊 Статус генерации: ${row.generation_status || row.status || "pending"}\n`;
    message += `🔤 Язык: ${row.language || "ru"}\n`;
    message += `🎵 Название: ${row.title || "—"}\n`;
    if (row.audio_url) message += `🎧 Аудио: ${row.audio_url}\n`;
    const chunks = message.match(/[\s\S]{1,4000}/g) || [message];
    for (const chunk of chunks) await ctx.reply(chunk);
    if (row.audio_url) {
      try {
        await ctx.replyWithAudio({ url: row.audio_url });
      } catch (e) {
        console.warn("[/full_analysis] Не удалось отправить аудио:", e?.message);
      }
    }
  } catch (err) {
    console.error("[/full_analysis] Ошибка:", err);
    await ctx.reply(`❌ Ошибка: ${err?.message || err}`);
  }
});

// Любая неизвестная команда — подсказка (чтобы не было «пустого» отклика)
bot.on("message:text", async (ctx, next) => {
  const text = (ctx.message?.text || "").trim();
  if (!text.startsWith("/")) return next();
  const cmd = text.split(/\s/)[0].toLowerCase();
  if (["/start", "/ping", "/get_analysis", "/admin", "/admin_check", "/astro", "/full_analysis"].includes(cmd)) return next();
  await ctx.reply("Неизвестная команда. Доступны: /start — открыть приложение, /get_analysis — расшифровка после оплаты. Админам: /admin, /admin_check, /astro <id>, /full_analysis <id>. Проверка связи: /ping.");
});

bot.command("admin_check", async (ctx) => {
  const userId = ctx?.from?.id;
  const chatId = ctx?.chat?.id ?? userId;
  const targetId = chatId || userId;
  const send = async (msg) => {
    try {
      await ctx.reply(msg);
    } catch (e) {
      console.error("[admin_check] ctx.reply:", e?.message || e);
      if (targetId) await bot.api.sendMessage(targetId, msg).catch((e2) => console.error("[admin_check] sendMessage:", e2?.message));
    }
  };
  if (!ADMIN_IDS.length) {
    await send("ADMIN_TELEGRAM_IDS не задан в Render (Environment). Добавь свой Telegram ID и перезапусти бота.");
    return;
  }
  if (!isAdmin(userId)) {
    await send("Нет доступа. Твой ID: " + (userId ?? "?") + ". Добавь в ADMIN_TELEGRAM_IDS в Render.");
    return;
  }
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
  const msg = ctx.update?.message;
  const userId = ctx?.from?.id ?? msg?.from?.id;
  const chatId = ctx?.chat?.id ?? msg?.chat?.id ?? userId;
  const targetId = chatId || userId;
  // #region agent log
  const p1 = { location: "index.js:admin-cmd", message: "admin command handler entered", data: { userId, chatId, hasChat: !!ctx.chat, hasFrom: !!ctx.from, adminIdsLength: ADMIN_IDS.length, isAdmin: !!userId && ADMIN_IDS.includes(Number(userId)) }, timestamp: Date.now(), hypothesisId: "H2,H3,H4" };
  debugLog(p1);
  fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p1) }).catch(() => {});
  // #endregion

  const reply = async (text) => {
    try {
      return await ctx.reply(text);
    } catch (e) {
      console.error("[admin] ctx.reply:", e?.message || e);
      if (targetId) return bot.api.sendMessage(targetId, text).catch((e2) => console.error("[admin] sendMessage:", e2?.message));
    }
  };

  const replyAny = (text) => {
    if (targetId) bot.api.sendMessage(targetId, text).catch((e) => console.error("[admin] replyAny:", e?.message));
  };

  const getAdminUrl = () => {
    if (!BOT_PUBLIC_URL) return null;
    const path = "/admin-simple";
    const token = ADMIN_SECRET ? "?token=" + encodeURIComponent(ADMIN_SECRET) : "";
    return BOT_PUBLIC_URL + path + token;
  };

  const sendAdminLink = () => {
    if (!targetId) return;
    const url = getAdminUrl();
    if (url) {
      bot.api.sendMessage(
        targetId,
        "👑 Веб-админка — нажми ссылку (токен уже подставлен, вводить ничего не нужно):\n\n" + url
      ).catch(() => {});
    } else {
      bot.api.sendMessage(
        targetId,
        "👑 Ссылка на админку не пришла: не задан базовый URL.\n\nВ Render → Environment добавь одну из переменных:\nBOT_PUBLIC_URL или HEROES_API_BASE = https://твой-сервис.onrender.com\n(без слэша в конце). Перезапусти сервис и снова напиши /admin."
      ).catch(() => {});
    }
  };

  /** Сначала гарантированно отправить ссылку одним сообщением (await), потом уже список заявок */
  const sendLinkFirst = async () => {
    if (!targetId) return;
    const url = getAdminUrl();
    const text = url
      ? "👑 Ссылка на админку (нажми — откроется, токен уже в ссылке):\n\n" + url
      : "👑 Не задан BOT_PUBLIC_URL или HEROES_API_BASE в Render → Environment. Добавь переменную и перезапусти сервис.";
    await bot.api.sendMessage(targetId, text).catch((e) => console.error("[admin] sendLinkFirst:", e?.message || e));
  };

  try {
    if (!targetId) {
      // #region agent log
      const p4 = { location: "index.js:admin-cmd", message: "admin early return: no targetId (no chat/from)", data: {}, timestamp: Date.now(), hypothesisId: "H4" };
      debugLog(p4);
      fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p4) }).catch(() => {});
      // #endregion
      console.warn("[admin] Нет chat/from в апдейте");
      return;
    }
    console.log("[admin] chatId=" + chatId + " userId=" + userId + " isAdmin=" + isAdmin(userId) + " ADMIN_IDS=" + JSON.stringify(ADMIN_IDS));

    if (!ADMIN_IDS.length) {
      // #region agent log
      const p2 = { location: "index.js:admin-cmd", message: "admin branch: ADMIN_IDS empty", data: {}, timestamp: Date.now(), hypothesisId: "H2" };
      debugLog(p2);
      fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p2) }).catch(() => {});
      // #endregion
      await reply("В Render (Environment) не задан ADMIN_TELEGRAM_IDS. Добавь: ADMIN_TELEGRAM_IDS=твой_Telegram_ID (узнать ID: @userinfobot), затем перезапусти сервис.");
      sendAdminLink();
      return;
    }
    if (!isAdmin(userId)) {
      // #region agent log
      const p2b = { location: "index.js:admin-cmd", message: "admin branch: user not admin", data: { userId, adminIds: ADMIN_IDS }, timestamp: Date.now(), hypothesisId: "H2" };
      debugLog(p2b);
      fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p2b) }).catch(() => {});
      // #endregion
      await reply("Нет доступа к админке. Твой Telegram ID: " + (userId ?? "?") + ". Добавь в Render → Environment: ADMIN_TELEGRAM_IDS=" + (userId ?? "ТВОЙ_ID") + " и перезапусти бота.");
      return;
    }

    // #region agent log
    const p5 = { location: "index.js:admin-cmd", message: "admin passed checks, sending link and fetching requests", data: { hasBotPublicUrl: !!process.env.BOT_PUBLIC_URL }, timestamp: Date.now(), hypothesisId: "H5" };
    debugLog(p5);
    fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p5) }).catch(() => {});
    // #endregion

    // Сначала обязательно отправляем ссылку — чтобы пользователь получил её даже если дальше что-то упадёт
    await sendLinkFirst();

    const adminUrl = getAdminUrl();
    const adminLinkLine = adminUrl
      ? `\n\n👑 Админка (ещё раз):\n${adminUrl}`
      : "";
    reply("Проверяю заявки…" + adminLinkLine).catch(() => {
      if (targetId) bot.api.sendMessage(targetId, "Проверяю заявки…").catch(() => {});
    });

    const { requests, dbError } = await getRequestsForAdmin(30);
    // #region agent log
    const p5b = { location: "index.js:admin-cmd", message: "getRequestsForAdmin returned", data: { dbError, requestsLength: (requests || []).length }, timestamp: Date.now(), hypothesisId: "H5" };
    debugLog(p5b);
    fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p5b) }).catch(() => {});
    // #endregion

    if (dbError) {
      await reply(
        "Не удалось загрузить заявки из базы (таймаут или ошибка Supabase).\n\nКоманда /admin_check — проверка подключения к базе."
      );
      sendAdminLink();
      return;
    }
    if (!requests.length) {
      const hint = supabase
        ? "Заявок пока нет.\n\nОтправь заявку из приложения (кнопка меню → форма → «Отправить заявку»). Затем снова /admin или /admin_check."
        : "Заявок пока нет. Supabase не подключён — заявки только в памяти.";
      await reply(hint);
      sendAdminLink();
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
    await sendLongMessage(ctx, text).catch(async (e) => {
      console.error("[admin] sendLongMessage:", e?.message || e);
      await reply("Не удалось отправить список (ошибка Telegram). Попробуй /admin ещё раз.");
    });
  } catch (err) {
    // #region agent log
    const p5c = { location: "index.js:admin-cmd", message: "admin handler catch", data: { errorMessage: err?.message || String(err) }, timestamp: Date.now(), hypothesisId: "H5" };
    debugLog(p5c);
    fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p5c) }).catch(() => {});
    // #endregion
    console.error("[admin] Ошибка:", err?.message || err);
    replyAny("Ошибка при выполнении /admin. Попробуй /admin_check или подожди минуту (сервер мог проснуться) и напиши /admin снова.");
    sendAdminLink();
  }
});

// Регистрация команд в Telegram (меню бота)
const commands = [
  { command: "start", description: "Начать / открыть приложение" },
  { command: "ping", description: "Проверка связи с ботом" },
  { command: "get_analysis", description: "Расшифровка карты (после оплаты)" },
  { command: "admin", description: "Админ: ссылка на админку и список заявок" },
  { command: "admin_check", description: "Админ: проверка базы" },
];
bot.api.setMyCommands(commands).catch(() => {});
bot.api.setMyCommands(commands, { scope: { type: "all_private_chats" } }).catch(() => {});

// Для русскоязычного меню (часть клиентов показывает команды по языку)
bot.api.setMyCommands(commands, { language_code: "ru" }).catch(() => {});

// HTTP: сначала слушаем порт (для Render health check), потом подключаем API и бота
const app = express();
// Вебхук — до express.json(), чтобы получать raw body (нужно для grammY)
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").replace(/\/$/, "");
// Базовый URL для ссылки на админку: BOT_PUBLIC_URL, WEBHOOK_URL или HEROES_API_BASE (как в инструкции Render)
const BOT_PUBLIC_URL = (process.env.BOT_PUBLIC_URL || process.env.WEBHOOK_URL || process.env.HEROES_API_BASE || "").replace(/\/webhook\/?$/i, "").replace(/\/$/, "");
if (WEBHOOK_URL) {
  app.use("/webhook", express.raw({ type: "application/json" }), webhookCallback(bot, "express"));
}
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init, X-Admin-Token, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// Health check: и для Render, и для «пробуждения» в браузере — показываем страницу, а не пустой/серый экран
const healthHtml =
  "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>YupSoul Bot</title><style>body{font-family:sans-serif;padding:2rem;max-width:32rem;margin:0 auto;} a{margin:0 .25rem}</style></head><body><h1>Сервис работает</h1><p>Бот пробуждён — можно писать ему в Telegram.</p><p><a href=\"/\">Главная</a> · <a href=\"/admin-simple\">Админка</a></p></body></html>";
app.get("/healthz", (_req, res) =>
  res.status(200).set("Content-Type", "text/html; charset=utf-8").send(healthHtml)
);
app.get("/", (_req, res) =>
  res.status(200).set("Content-Type", "text/html; charset=utf-8").send(
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>YupSoul Bot</title></head><body><p>YupSoul Bot работает.</p><p>Проверка: <a href=\"/healthz\">/healthz</a></p><p>Админка: <a href=\"/admin\">/admin</a> · <a href=\"/admin-simple\">/admin-simple</a></p><p>Статус webhook: <a href=\"/healthz?webhook=1\">/healthz?webhook=1</a> — если бот не видит команды.</p><p>Приложение открывай из Telegram — кнопка меню бота.</p></body></html>"
  )
);
// Обработчик /api/me (чтобы не было 500 ошибки)
app.get("/api/me", (_req, res) => {
  res.json({ ok: true, user: null, authenticated: false });
});

function resolveAdminAuth(req) {
  const initData = req.headers["x-telegram-init"] || req.query?.initData || req.body?.initData;
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId != null && isAdmin(telegramUserId)) return { admin: true, userId: telegramUserId };
  const token = req.headers["x-admin-token"] || req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query?.token;
  if (ADMIN_SECRET && token === ADMIN_SECRET) return { admin: true, userId: "token" };
  return null;
}

function asyncApi(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get("/admin", (req, res) => {
  const adminPath = path.join(__dirname, "admin.html");
  res.type("html");
  res.sendFile(adminPath, (err) => {
    if (err) {
      console.error("[admin] sendFile error:", err.message);
      res.status(500).send("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Ошибка</title></head><body><p>Файл админки не найден. Проверь, что admin.html задеплоен вместе с ботом (папка bot).</p><p><a href='/'>На главную</a></p></body></html>");
    }
  });
});

// #region agent log
app.use("/api/admin", (req, res, next) => {
  debugLog({ location: "index.js:api-admin", message: "admin API request", data: { path: req.path, method: req.method }, timestamp: Date.now(), hypothesisId: "admin-html" });
  next();
});
// #endregion

app.get("/api/admin/me", (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ error: "Доступ только для админа", admin: false });
  return res.json({ admin: true, userId: auth.userId });
});

app.get("/api/admin/stats", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  let result = await supabase.from("track_requests").select("generation_status");
  if (result.error && /does not exist|column/i.test(result.error.message)) {
    result = await supabase.from("track_requests").select("status");
  }
  if (result.error) return res.status(500).json({ success: false, error: result.error.message });
  const rows = result.data || [];
  const stats = { total: rows.length, pending: 0, astro_calculated: 0, lyrics_generated: 0, suno_processing: 0, completed: 0, failed: 0 };
  rows.forEach((r) => {
    const s = (r.generation_status ?? r.status) || "pending";
    if (s === "completed") stats.completed++;
    else if (s === "failed") stats.failed++;
    else if (s === "suno_processing") stats.suno_processing++;
    else if (s === "lyrics_generated") stats.lyrics_generated++;
    else if (s === "astro_calculated") stats.astro_calculated++;
    else stats.pending++;
  });
  return res.json({ success: true, stats });
}));

app.get("/api/admin/requests", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 100);
  const statusFilter = req.query?.status || "all";
  const fullSelect = "id, name, person2_name, status, generation_status, created_at, audio_url, mode, request, generation_steps";
  let q = supabase.from("track_requests").select(fullSelect).order("created_at", { ascending: false }).limit(limit);
  if (statusFilter === "pending") q = q.in("generation_status", ["pending", "astro_calculated", "lyrics_generated", "suno_processing"]);
  else if (statusFilter === "completed") q = q.eq("generation_status", "completed");
  else if (statusFilter === "failed") q = q.eq("generation_status", "failed");
  let result = await q;
  if (result.error && /does not exist|column/i.test(result.error.message)) {
    const minSelect = "id, name, status, created_at, request, telegram_user_id";
    let q2 = supabase.from("track_requests").select(minSelect).order("created_at", { ascending: false }).limit(limit);
    if (statusFilter === "completed") q2 = q2.eq("status", "completed");
    else if (statusFilter === "failed") q2 = q2.eq("status", "failed");
    result = await q2;
  }
  if (result.error) return res.status(500).json({ success: false, error: result.error.message });
  return res.json({ success: true, data: result.data || [] });
}));

// Убираем token из query, если попал в path (например /requests/xxx&token=yyy)
function sanitizeRequestId(paramId) {
  const s = typeof paramId === "string" ? paramId.split("&")[0].trim() : "";
  return s || null;
}

// Проверка полного UUID (с дефисами) — запросы с обрезанным ID вызывают "invalid input syntax for type uuid"
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidRequestId(id) {
  return typeof id === "string" && UUID_REGEX.test(id);
}

app.get("/api/admin/requests/:id", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const id = sanitizeRequestId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: "Неверный ID заявки" });
  if (!isValidRequestId(id)) return res.status(400).json({ success: false, error: "Используйте полный UUID заявки (с дефисами), не обрезанный ID" });
  const fullCols = "id,name,person2_name,gender,birthdate,birthplace,deepseek_response,lyrics,audio_url,request,created_at,status,generation_status,error_message,llm_truncated,generation_steps";
  let result = await supabase.from("track_requests").select(fullCols).eq("id", id).maybeSingle();
  if (result.error && /does not exist|column/i.test(result.error.message)) {
    const minCols = "id,name,gender,birthdate,birthplace,request,created_at,status,telegram_user_id";
    result = await supabase.from("track_requests").select(minCols).eq("id", id).maybeSingle();
  }
  if (result.error) return res.status(500).json({ success: false, error: result.error.message });
  if (!result.data) return res.status(404).json({ success: false, error: "Заявка не найдена" });
  return res.json({ success: true, data: result.data });
}));

app.post("/api/admin/requests/:id/restart", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const id = sanitizeRequestId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: "Неверный ID заявки" });
  if (!isValidRequestId(id)) return res.status(400).json({ success: false, error: "Используйте полный UUID заявки (с дефисами), не обрезанный ID" });
  const { error: updateError } = await supabase
    .from("track_requests")
    .update({
      status: "pending",
      generation_status: "pending",
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateError) return res.status(500).json({ success: false, error: updateError.message });
  import("./workerSoundKey.js").then(({ generateSoundKey }) => {
    generateSoundKey(id).catch((err) => console.error("[admin] restart generateSoundKey:", err?.message || err));
  }).catch((err) => console.error("[admin] restart import workerSoundKey:", err?.message || err));
  return res.json({ success: true, message: "Перезапущено" });
}));

app.get("/api/admin/settings", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const { data, error } = await supabase.from("app_settings").select("key, value");
  if (error) {
    if (/does not exist/i.test(error.message)) return res.json({ success: true, settings: {} });
    return res.status(500).json({ success: false, error: error.message });
  }
  const settings = {};
  (data || []).forEach((row) => { settings[row.key] = row.value; });
  const deepseek_max_tokens = settings.deepseek_max_tokens != null ? Math.max(1, Number(settings.deepseek_max_tokens)) : null;
  return res.json({ success: true, settings: { ...settings, deepseek_max_tokens: deepseek_max_tokens ?? undefined } });
}));

app.put("/api/admin/settings", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const { deepseek_max_tokens } = req.body || {};
  if (deepseek_max_tokens !== undefined) {
    const val = Math.max(1, Number(deepseek_max_tokens));
    const { error: upsertErr } = await supabase.from("app_settings").upsert(
      { key: "deepseek_max_tokens", value: String(val), updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (upsertErr) return res.status(500).json({ success: false, error: upsertErr.message });
  }
  return res.json({ success: true, message: "Настройки сохранены" });
}));

app.use("/api", (err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err?.message || "Ошибка сервера" });
});

app.get(["/admin-simple", "/admin-simple/"], (req, res) => {
  res.type("html").sendFile(path.join(__dirname, "admin-simple.html"), (err) => {
    if (err) res.status(500).send("<!DOCTYPE html><html><head><meta charset='utf-8'></head><body style='background:#0f0f1b;color:#fff;font-family:sans-serif;padding:40px;'><h1>Ошибка</h1><p>admin-simple.html не найден</p><a href='/admin' style='color:#667eea'>Админка</a></body></html>");
  });
});

app.get(["/webhook-info", "/webhook-info/"], async (_req, res) => {
  try {
    const info = await bot.api.getWebhookInfo();
    const url = info.url || "(не установлен)";
    const mode = WEBHOOK_URL ? " (режим вебхуков)" : "";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Webhook</title><style>body{font-family:sans-serif;padding:2rem;}</style></head><body><h1>Статус webhook</h1><p>URL: <strong>${url}</strong>${mode}</p><p>${WEBHOOK_URL ? "Вебхук установлен — Telegram шлёт апдейты сюда. Конфликта 409 не будет." : "При каждом старте бот сбрасывает webhook и использует long polling. Чтобы использовать вебхуки, задай WEBHOOK_URL в Render."}</p><p><a href="/">Главная</a></p></body></html>`;
    res.status(200).set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (e) {
    res.status(500).set("Content-Type", "text/html; charset=utf-8").send(`<html><body><p>Ошибка: ${e?.message || e}</p><a href="/">Главная</a></body></html>`);
  }
});

app.post("/suno-callback", express.json(), (req, res) => {
  res.status(200).send("ok");
  const taskId = req.body?.data?.taskId || req.body?.taskId;
  if (taskId) console.log("[Suno callback] taskId:", taskId, "stage:", req.body?.data?.stage || req.body?.stage);
});

// Запасной приём заявок: Mini App шлёт POST с initData + форма (если sendData в TG не срабатывает).
app.post("/api/submit-request", express.json(), async (req, res) => {
  const initData = req.body?.initData || req.headers["x-telegram-init"];
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) {
    return res.status(401).json({ error: "Неверные или устаревшие данные. Открой приложение из чата с ботом и попробуй снова." });
  }
  const body = req.body || {};
  const isNewFormat = body.person1 != null;
  let name, birthdate, birthplace, birthtime, birthtimeUnknown, gender, language, userRequest, clientId, birthplaceLat, birthplaceLon;
  if (isNewFormat) {
    const { mode, person1, person2, request: reqText, language: lang } = body;
    if (!person1?.name || !person1?.birthdate || !person1?.birthplace || !reqText) {
      return res.status(400).json({ error: "Не все обязательные поля заполнены (person1.name, birthdate, birthplace, request)" });
    }
    name = person1.name;
    birthdate = person1.birthdate;
    birthplace = person1.birthplace;
    birthtime = person1.birthtimeUnknown ? null : person1.birthtime;
    birthtimeUnknown = !!person1.birthtimeUnknown;
    gender = person1.gender || "";
    language = lang || "ru";
    userRequest = reqText;
    clientId = null;
    birthplaceLat = person1.birthplaceLat ?? null;
    birthplaceLon = person1.birthplaceLon ?? null;
  } else {
    name = body.name;
    birthdate = body.birthdate;
    birthplace = body.birthplace;
    birthtime = body.birthtime;
    birthtimeUnknown = !!body.birthtimeUnknown;
    gender = body.gender || "";
    language = body.language;
    userRequest = body.request;
    clientId = body.clientId;
    birthplaceLat = body.birthplaceLat;
    birthplaceLon = body.birthplaceLon;
  }
  let requestId;
  try {
    const saveData = {
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
      mode: isNewFormat && (body.mode === "couple" || body.mode === "transit") ? body.mode : "single",
    };
    if (saveData.mode === "couple" && body.person2) {
      saveData.person2_name = body.person2.name || null;
      saveData.person2_birthdate = body.person2.birthdate || null;
      saveData.person2_birthplace = body.person2.birthplace || null;
      saveData.person2_birthtime = body.person2.birthtimeUnknown ? null : (body.person2.birthtime || null);
      saveData.person2_birthtime_unknown = !!body.person2.birthtimeUnknown;
      saveData.person2_gender = body.person2.gender || null;
    }
    if ((saveData.mode === "transit" || body.transit) && body.transit) {
      saveData.transit_date = body.transit.date || null;
      saveData.transit_time = body.transit.time || null;
      saveData.transit_location = body.transit.location || null;
      saveData.transit_intent = body.transit.intent || null;
    }
    if (birthplaceLat != null && birthplaceLon != null) {
      saveData.birthplaceLat = birthplaceLat;
      saveData.birthplaceLon = birthplaceLon;
    }
    requestId = await saveRequest(saveData);
  } catch (err) {
    console.error("[submit-request] saveRequest:", err?.message || err);
    return res.status(500).json({ error: "Ошибка сохранения заявки" });
  }
  if (!requestId) {
    return res.status(500).json({ error: "Не удалось сохранить заявку" });
  }
  const mode = body.person1 && body.mode === "couple" ? "couple" : "single";
  console.log(`[API] Заявка ${requestId} сохранена — ГЕНЕРИРУЕМ ПЕСНЮ БЕСПЛАТНО (режим: ${mode})`);
  const successText =
    "✨ Твой звуковой ключ создаётся! Первый трек — в подарок 🎁\n\nЧерез 2–3 минуты он придёт в этот чат.";
  bot.api.sendMessage(telegramUserId, successText).catch((e) => console.warn("[submit-request] sendMessage:", e?.message));
  if (ADMIN_IDS.length) {
    const requestPreview = (userRequest || "").trim().slice(0, 150);
    const adminText =
      "🔔 Новая заявка (через API)\n\n" +
      `Имя: ${name || "—"}${mode === "couple" && body.person2?.name ? ` и ${body.person2.name}` : ""}\nЯзык: ${language || "—"}\nДата: ${birthdate || "—"} · Место: ${(birthplace || "—").slice(0, 40)}${(birthplace || "").length > 40 ? "…" : ""}\n` +
      `Запрос: ${requestPreview}${(userRequest || "").length > 150 ? "…" : ""}\n\nID: ${requestId}\nTG: ${telegramUserId}`;
    for (const adminId of ADMIN_IDS) {
      bot.api.sendMessage(adminId, adminText).catch((e) => console.warn("[Уведомление админу]", adminId, e.message));
    }
  }
  const hasPerson1Data = birthdate && birthplace;
  if (supabase && hasPerson1Data) {
    console.log(`[API] ЗАПУСКАЮ ВОРКЕР для ${requestId}`);
    (async () => {
      try {
        const module = await import("./workerSoundKey.js");
        if (typeof module.generateSoundKey !== "function") {
          throw new Error("Функция generateSoundKey не экспортирована");
        }
        await module.generateSoundKey(requestId);
        console.log(`[Воркер] УСПЕШНО завершён для ${requestId}`);
      } catch (error) {
        console.error(`[ВОРКЕР] КРИТИЧЕСКАЯ ОШИБКА для ${requestId}:`, error);
        await supabase.from("track_requests").update({
          generation_status: "failed",
          error_message: error?.message || String(error),
        }).eq("id", requestId);
      }
    })();
  } else {
    console.log(`[API] Воркер НЕ запущен для ${requestId}: ${!supabase ? "Supabase не подключен" : "нет даты/места рождения"}`);
  }
  return res.status(200).json({
    ok: true,
    requestId,
    message: "✨ Твой звуковой ключ создаётся! Первый трек — в подарок 🎁\nЧерез 2-3 минуты он придёт в этот чат.",
  });
});

async function onBotStart(info) {
  console.log("Бот запущен:", info.username);
  // #region agent log
  const p0 = { location: "index.js:onBotStart", message: "bot started", data: { adminIdsLength: ADMIN_IDS.length, hasWebhookUrl: !!process.env.WEBHOOK_URL }, timestamp: Date.now(), hypothesisId: "H1" };
  debugLog(p0);
  fetch("http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p0) }).catch(() => {});
  // #endregion
  if (ADMIN_IDS.length) console.log("Админы (ID):", ADMIN_IDS.join(", "));
  else console.warn("ADMIN_TELEGRAM_IDS не задан — команда /admin недоступна.");
  if (supabase) {
    console.log("Supabase: подключен, URL:", SUPABASE_URL);
    const { count, error } = await supabase.from("track_requests").select("id", { count: "exact", head: true });
    if (error) console.error("Supabase: ошибка таблицы track_requests:", error.message);
    else console.log("Supabase: в таблице track_requests записей:", count ?? 0);
  } else console.log("Supabase: не подключен (заявки только в памяти).");

  // Уведомление админам о перезапуске/обновлении бота
  if (ADMIN_IDS.length) {
    const time = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
    const text = "🔄 Бот обновлён и запущен.\n\n" + time;
    for (const adminId of ADMIN_IDS) {
      bot.api.sendMessage(adminId, text).catch((e) => console.warn("[onStart] Уведомление админу", adminId, e?.message));
    }
  }
}

/** Long polling: сбрасываем webhook и запускаем опрос getUpdates. */
async function startBotWithPolling() {
  try {
    const info = await bot.api.getWebhookInfo();
    if (info.url) {
      console.warn("[Bot] Был установлен webhook:", info.url, "— сбрасываю для long polling.");
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      console.log("[Bot] Webhook сброшен.");
    } else {
      console.log("[Bot] Webhook не установлен — запускаю long polling.");
    }
    await bot.start({ onStart: onBotStart });
  } catch (err) {
    console.error("Ошибка запуска бота:", err?.message || err);
  }
}

/** Режим вебхуков: один инстанс получает апдейты, нет конфликта 409 при нескольких репликах. */
async function startBotWithWebhook() {
  try {
    const url = WEBHOOK_URL + "/webhook";
    await bot.api.setWebhook(url);
    console.log("[Bot] Вебхук установлен:", url);
    const me = await bot.api.getMe();
    await onBotStart(me);
  } catch (err) {
    console.error("[Bot] Ошибка установки вебхука:", err?.message || err);
  }
}

if (process.env.RENDER_HEALTHZ_FIRST) {
  app.use("/api", createHeroesRouter(supabase, BOT_TOKEN));
  globalThis.__EXPRESS_APP__ = app;
  if (WEBHOOK_URL) {
    startBotWithWebhook();
  } else {
    startBotWithPolling();
  }
} else {
  console.log("[HTTP] Слушаю порт", HEROES_API_PORT);
  app.use("/api", createHeroesRouter(supabase, BOT_TOKEN));
  app.listen(HEROES_API_PORT, "0.0.0.0", () => {
    console.log("[HTTP] Порт открыт:", HEROES_API_PORT);
    if (WEBHOOK_URL) {
      startBotWithWebhook();
    } else {
      startBotWithPolling();
    }
  });
}
