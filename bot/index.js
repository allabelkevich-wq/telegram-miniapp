/**
 * YupSoul Telegram Bot
 * Принимает заявки из Mini App (sendData), сохраняет, отвечает пользователю.
 * HTTP API для «Мои герои» (тариф Мастер).
 */

import { Bot, webhookCallback } from "grammy";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createHeroesRouter, getOrCreateAppUser, validateInitData } from "./heroesApi.js";
import { chatCompletion } from "./deepseek.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Лог всегда в корне проекта (workspace), чтобы его можно было прочитать при любом cwd

const BOT_TOKEN = process.env.BOT_TOKEN;
function normalizeUrlBase(raw) {
  return String(raw || "")
    .trim()
    .replace(/\?.*$/, "")
    .replace(/\/$/, "");
}
// Важно: если MINI_APP_URL в Render задан неверно (например, старый Vercel),
// Telegram будет открывать 404. Поэтому приоритет всегда у RENDER_EXTERNAL_URL.
// Vercel fallback убран — если нет RENDER_EXTERNAL_URL, бот не запустится (fail-fast).
const MINI_APP_BASE = normalizeUrlBase(process.env.RENDER_EXTERNAL_URL || process.env.MINI_APP_URL || "");
if (!MINI_APP_BASE || MINI_APP_BASE.includes("vercel.app")) {
  console.error("FATAL: RENDER_EXTERNAL_URL не задан или указывает на Vercel. Задай RENDER_EXTERNAL_URL в Render Dashboard.");
  process.exit(1);
}
const APP_BUILD = Date.now(); // Меняется при каждом перезапуске — для cache-busting в браузере
// MINI_APP_URL — с timestamp для menu button и /start (принудительный сброс кеша)
const MINI_APP_URL = MINI_APP_BASE.replace(/\/app\/?$/, "") + "/app?v=" + APP_BUILD;
// MINI_APP_STABLE_URL — без timestamp, для bot-сообщений с кнопками (не меняется при деплоях)
const MINI_APP_STABLE_URL = MINI_APP_BASE.replace(/\/app\/?$/, "") + "/app";
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
const HOT_API_JWT = process.env.HOT_API_JWT || "";
const HOT_WEBHOOK_SECRET = process.env.HOT_WEBHOOK_SECRET || "";
const HOT_PAYMENT_URL = (process.env.HOT_PAYMENT_URL || "https://pay.hot-labs.org/payment").trim();

if (!BOT_TOKEN) {
  console.error("Укажи BOT_TOKEN в .env (получить у @BotFather)");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Обработчик ошибок бота
bot.catch((err) => {
  console.error("[Bot] Ошибка обработки сообщения:", err);
  console.error("[Bot] Контекст:", err.ctx ? {
    message: err.ctx.message?.text,
    from: err.ctx.from?.username,
    chat: err.ctx.chat?.id
  } : 'нет контекста');
});

// Лог входящих апдейтов и сразу «печатает…» — чтобы сообщение не казалось «не отправленным»
bot.use(async (ctx, next) => {
  const msg = ctx.message;
  const fromId = ctx.from?.id;
  if (msg?.text) {
    console.log("[TG] msg from", fromId, ":", msg.text.slice(0, 80) + (msg.text.length > 80 ? "…" : ""));
  }
  const chatId = ctx.chat?.id;
  if (chatId) ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  return next();
});

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const memoryRequests = [];
const pendingSoulChatByUser = new Map();

const DEFAULT_PRICING_CATALOG = [
  { sku: "single_song", title: "Single song", description: "Персональный звуковой ключ", price: "5.99", currency: "USDT", active: true, limits_json: { requests: 1 } },
  { sku: "transit_energy_song", title: "Transit energy song", description: "Энергия дня (транзит)", price: "6.99", currency: "USDT", active: true, limits_json: { requests: 1 } },
  { sku: "couple_song", title: "Couple song", description: "Песня совместимости пары", price: "8.99", currency: "USDT", active: true, limits_json: { requests: 1 } },
  { sku: "deep_analysis_addon", title: "Deep analysis", description: "Дополнительный детальный разбор", price: "3.99", currency: "USDT", active: true, limits_json: { requests: 1 } },
  { sku: "extra_regeneration", title: "Extra regeneration", description: "Повторная генерация трека", price: "2.49", currency: "USDT", active: true, limits_json: { requests: 1 } },
  { sku: "soul_basic_sub", title: "Soul Basic", description: "3 трека/месяц + 10 soulchat", price: "14.99", currency: "USDT", active: true, limits_json: { monthly_tracks: 3, monthly_soulchat: 10, kind: "subscription" } },
  { sku: "soul_plus_sub", title: "Soul Plus", description: "7 треков/месяц + 30 soulchat + приоритет", price: "24.99", currency: "USDT", active: true, limits_json: { monthly_tracks: 7, monthly_soulchat: 30, priority: true, kind: "subscription" } },
];

function resolveSkuByMode(mode) {
  if (mode === "couple") return "couple_song";
  if (mode === "transit") return "transit_energy_song";
  return "single_song";
}

function parseJsonSafe(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

async function getPricingCatalog() {
  if (!supabase) return DEFAULT_PRICING_CATALOG;
  const { data, error } = await supabase
    .from("pricing_catalog")
    .select("sku,title,description,price,currency,active,limits_json")
    .order("sku", { ascending: true });
  if (error && /does not exist|relation/i.test(error.message)) return DEFAULT_PRICING_CATALOG;
  if (error || !Array.isArray(data) || data.length === 0) return DEFAULT_PRICING_CATALOG;
  return data.map((row) => ({ ...row, limits_json: parseJsonSafe(row.limits_json, {}) || {} }));
}

async function getSkuPrice(sku) {
  const catalog = await getPricingCatalog();
  const found = catalog.find((c) => c.sku === sku && c.active !== false);
  return found || catalog.find((c) => c.sku === sku) || null;
}

function normalizePromoCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

async function getPromoByCode(code) {
  const normalized = normalizePromoCode(code);
  if (!normalized || !supabase) return null;
  const { data, error } = await supabase
    .from("promo_codes")
    .select("*")
    .eq("code", normalized)
    .maybeSingle();
  if (error && /does not exist|relation/i.test(error.message)) return null;
  if (error) return null;
  return data || null;
}

async function getPromoUsageByUser(promoCodeId, telegramUserId) {
  if (!supabase) return 0;
  const { count, error } = await supabase
    .from("promo_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("promo_code_id", promoCodeId)
    .eq("telegram_user_id", Number(telegramUserId));
  if (error && /does not exist|relation/i.test(error.message)) return 0;
  if (error) return 0;
  return Number(count || 0);
}

async function validatePromoForOrder({ promoCode, sku, telegramUserId }) {
  const code = normalizePromoCode(promoCode);
  if (!code) return { ok: false, reason: "empty" };
  const promo = await getPromoByCode(code);
  if (!promo) return { ok: false, reason: "not_found" };
  if (promo.active === false) return { ok: false, reason: "inactive" };
  const now = Date.now();
  if (promo.starts_at && new Date(promo.starts_at).getTime() > now) return { ok: false, reason: "not_started" };
  if (promo.expires_at && new Date(promo.expires_at).getTime() < now) return { ok: false, reason: "expired" };
  if (promo.sku && promo.sku !== sku) return { ok: false, reason: "sku_mismatch" };
  if (promo.max_uses != null && Number(promo.used_count || 0) >= Number(promo.max_uses)) return { ok: false, reason: "global_limit_reached" };
  const userUses = await getPromoUsageByUser(promo.id, telegramUserId);
  if (userUses >= Number(promo.per_user_limit || 1)) return { ok: false, reason: "user_limit_reached" };
  return { ok: true, promo, code };
}

function applyPromoToAmount(baseAmount, promo) {
  const amount = Number(baseAmount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return { finalAmount: 0, discountAmount: 0 };
  const type = String(promo?.type || "");
  if (type === "free_generation") return { finalAmount: 0, discountAmount: amount };
  if (type === "discount_percent") {
    const percent = Math.max(0, Math.min(100, Number(promo?.value || 0)));
    const discount = Number((amount * percent / 100).toFixed(2));
    return { finalAmount: Number(Math.max(0, amount - discount).toFixed(2)), discountAmount: discount };
  }
  if (type === "discount_amount") {
    const discount = Math.max(0, Number(promo?.value || 0));
    return { finalAmount: Number(Math.max(0, amount - discount).toFixed(2)), discountAmount: Number(Math.min(amount, discount).toFixed(2)) };
  }
  return { finalAmount: amount, discountAmount: 0 };
}

async function redeemPromoUsage({ promo, telegramUserId, requestId, orderId, discountAmount = 0 }) {
  if (!supabase || !promo?.id) return { ok: false };
  const { data: existing, error: existingErr } = await supabase
    .from("promo_redemptions")
    .select("id")
    .eq("promo_code_id", promo.id)
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("request_id", requestId || null)
    .maybeSingle();
  if (!existingErr && existing) return { ok: true, reused: true };
  const { error: insErr } = await supabase.from("promo_redemptions").insert({
    promo_code_id: promo.id,
    telegram_user_id: Number(telegramUserId),
    request_id: requestId || null,
    order_id: orderId ? String(orderId) : null,
    discount_amount: Number(discountAmount || 0),
    created_at: new Date().toISOString(),
  });
  if (insErr && !/does not exist|relation/i.test(insErr.message)) return { ok: false, error: insErr.message };
  const nextCount = Number(promo.used_count || 0) + 1;
  await supabase.from("promo_codes").update({ used_count: nextCount, updated_at: new Date().toISOString() }).eq("id", promo.id);
  return { ok: true };
}

async function isTrialAvailable(telegramUserId, trialKey = "first_song_gift") {
  console.log("[Trial] Проверка доступности пробной версии для пользователя:", telegramUserId, "ключ:", trialKey);
  
  if (!supabase) {
    console.log("[Trial] Supabase не подключен, разрешаем пробную версию");
    return true;
  }
  
  const { data, error } = await supabase
    .from("user_trials")
    .select("id")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("trial_key", trialKey)
    .maybeSingle();
  
  if (error) {
    console.error("[Trial] Ошибка запроса к user_trials:", error.message);
    // При любой ошибке БД разрешаем пробную версию —
    // consumeTrial защитит от повторного использования через duplicate key
    console.log("[Trial] Ошибка БД → разрешаем пробную версию (consumeTrial проверит дубль)");
    return true;
  }
  
  const available = !data;
  console.log("[Trial] Результат проверки:", available ? "доступна" : "уже использована", "данные:", data);
  return available;
}

async function consumeTrial(telegramUserId, trialKey = "first_song_gift") {
  if (!supabase) return { ok: true };
  // Сразу пробуем INSERT — уникальный индекс сам защитит от повторного использования.
  // Убрана двойная проверка isTrialAvailable во избежание состояния гонки и ложного 402.
  const { error } = await supabase.from("user_trials").insert({
    telegram_user_id: Number(telegramUserId),
    trial_key: trialKey,
    consumed_at: new Date().toISOString(),
  });
  if (!error) return { ok: true };
  if (/does not exist|relation/i.test(error.message)) return { ok: true }; // таблицы нет — разрешаем
  if (/duplicate key value/i.test(error.message)) return { ok: false, reason: "already_consumed" };
  // При любой другой ошибке — разрешаем (лучше дать бесплатный запрос, чем заблокировать)
  console.warn("[Trial] consumeTrial неизвестная ошибка, разрешаем:", error.message);
  return { ok: true };
}

async function hasActiveSubscription(telegramUserId) {
  if (!supabase) return false;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("id,plan_sku,status,renew_at")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("status", "active")
    .gte("renew_at", nowIso)
    .limit(1)
    .maybeSingle();
  if (error && /does not exist|relation/i.test(error.message)) return false;
  if (error) return false;
  return !!data;
}

async function consumeEntitlementIfExists(telegramUserId, sku) {
  if (!supabase) return { ok: false };
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("user_entitlements")
    .select("id,remaining_uses,expires_at")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("sku", sku)
    .or(`expires_at.is.null,expires_at.gte.${nowIso}`)
    .gt("remaining_uses", 0)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error && /does not exist|relation/i.test(error.message)) return { ok: false };
  if (error || !data) return { ok: false };
  const nextUses = Math.max(0, Number(data.remaining_uses || 0) - 1);
  const { error: upErr } = await supabase
    .from("user_entitlements")
    .update({ remaining_uses: nextUses, updated_at: new Date().toISOString() })
    .eq("id", data.id);
  if (upErr) return { ok: false };
  return { ok: true, remaining_uses: nextUses };
}

async function resolveAccessForRequest({ telegramUserId, mode }) {
  console.log("[Access] Проверка доступа для пользователя:", telegramUserId, "режим:", mode);
  
  const sku = resolveSkuByMode(mode);
  console.log("[Access] Определен SKU:", sku);
  
  const hasSubscription = await hasActiveSubscription(telegramUserId);
  console.log("[Access] Проверка подписки:", hasSubscription ? "активна" : "неактивна");
  if (hasSubscription) return { allowed: true, source: "subscription", sku };
  
  const ent = await consumeEntitlementIfExists(telegramUserId, sku);
  console.log("[Access] Проверка entitlement:", ent.ok ? "найден и потреблен" : "не найден");
  if (ent.ok) return { allowed: true, source: "entitlement", sku };
  
  const trialAvailable = await isTrialAvailable(telegramUserId, "first_song_gift");
  console.log("[Access] Проверка пробной версии:", trialAvailable ? "доступна" : "недоступна");
  if (trialAvailable) return { allowed: true, source: "trial", sku };
  
  console.log("[Access] Доступ запрещен, требуется оплата");
  return { allowed: false, source: "payment_required", sku };
}

async function grantEntitlement({ telegramUserId, sku, uses = 1, source = "payment", expiresAt = null }) {
  if (!supabase) return { ok: false, error: "Supabase недоступен" };
  const payload = {
    telegram_user_id: Number(telegramUserId),
    sku,
    source,
    remaining_uses: Number(uses) || 1,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("user_entitlements").insert(payload);
  if (error && /does not exist|relation/i.test(error.message)) return { ok: false, error: "missing_table" };
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

function pickHotItemId(sku) {
  const envKey = `HOT_ITEM_ID_${String(sku || "").toUpperCase()}`;
  return process.env[envKey] || process.env.HOT_ITEM_ID_DEFAULT || "";
}

function buildHotCheckoutUrl({ itemId, orderId, amount, currency, requestId, sku }) {
  const url = new URL(HOT_PAYMENT_URL || "https://pay.hot-labs.org/payment");
  if (itemId) url.searchParams.set("item_id", itemId);
  if (orderId) url.searchParams.set("order_id", orderId);
  // HOT официально: memo — идентификатор заказа, приходит в webhook.
  if (orderId) url.searchParams.set("memo", orderId);
  if (amount != null) url.searchParams.set("amount", String(amount));
  if (currency) url.searchParams.set("currency", String(currency));
  if (requestId) url.searchParams.set("request_id", requestId);
  if (sku) url.searchParams.set("sku", sku);
  // redirect_url: после оплаты HOT отправляет пользователя сюда.
  // Используем /app путь, чтобы мини-апп открылся и определил payment=success.
  const redirectUrl = process.env.HOT_REDIRECT_URL ||
    (MINI_APP_STABLE_URL + "?payment=success&request_id=" + encodeURIComponent(requestId || ""));
  if (redirectUrl) url.searchParams.set("redirect_url", redirectUrl);
  // notify_url: HOT шлёт webhook сюда при изменении статуса платежа.
  // Без этого параметра — webhook нужно настраивать вручную в кабинете HOT.
  const notifyUrl = process.env.HOT_NOTIFY_URL ||
    (MINI_APP_BASE.replace(/\/app\/?$/, "") + "/api/payments/hot/webhook");
  url.searchParams.set("notify_url", notifyUrl);
  return url.toString();
}

function verifyHotWebhookSignature(rawBody, signatureHeader) {
  if (!HOT_WEBHOOK_SECRET) return true;
  if (!signatureHeader || !rawBody) return false;
  const expected = crypto.createHmac("sha256", HOT_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const providedRaw = String(signatureHeader).trim();
  const provided = providedRaw.includes("=") ? providedRaw.split("=")[1] : providedRaw;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

async function createOrRefreshSubscription({ telegramUserId, planSku, source = "hot" }) {
  if (!supabase) return { ok: false, error: "Supabase недоступен" };
  const now = new Date();
  const renewAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    telegram_user_id: Number(telegramUserId),
    plan_sku: planSku,
    status: "active",
    renew_at: renewAt,
    source,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("subscriptions").insert(payload);
  if (error && /does not exist|relation/i.test(error.message)) return { ok: false, error: "missing_table" };
  if (error) return { ok: false, error: error.message };
  return { ok: true, renew_at: renewAt };
}

async function grantPurchaseBySku({ telegramUserId, sku, source = "hot_payment", orderId = null }) {
  const normalizedSku = String(sku || "").trim();
  if (!normalizedSku) return { ok: false, error: "sku_required" };
  if (normalizedSku === "soul_basic_sub" || normalizedSku === "soul_plus_sub") {
    return createOrRefreshSubscription({ telegramUserId, planSku: normalizedSku, source });
  }
  if (normalizedSku === "soul_chat_1day") {
    return activateSoulChatDay(telegramUserId, orderId);
  }
  return grantEntitlement({ telegramUserId, sku: normalizedSku, uses: 1, source });
}

function isAdmin(telegramId) {
  return telegramId && ADMIN_IDS.includes(Number(telegramId));
}

async function getLastCompletedRequestForUser(telegramUserId) {
  if (!supabase || !telegramUserId) return null;
  // Проверяем оба поля статуса: status и generation_status
  const { data } = await supabase
    .from("track_requests")
    .select("id")
    .eq("telegram_user_id", Number(telegramUserId))
    .not("mode", "eq", "soul_chat_day") // исключаем служебные записи покупки
    .in("generation_status", ["completed", "done"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data) return data.id;
  // Фолбек: любая не-служебная заявка
  const { data: any } = await supabase
    .from("track_requests")
    .select("id")
    .eq("telegram_user_id", Number(telegramUserId))
    .not("mode", "eq", "soul_chat_day")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return any ? any.id : null;
}

/** Доступ к Soul Chat: по подписке Soul Basic / Soul Plus (включают N диалогов в месяц). */
async function getSoulChatAccess(telegramUserId) {
  if (!telegramUserId) return { allowed: false, reason: "Нужна авторизация Telegram." };

  // 1. Активная подписка Soul Basic / Soul Plus
  const hasSub = await hasActiveSubscription(telegramUserId);
  if (hasSub) return { allowed: true, source: "subscription", expires_at: null };

  // 2. Активный суточный доступ (подарочный или купленный)
  if (supabase) {
    const nowIso = new Date().toISOString();
    const { data: dayAccess } = await supabase
      .from("soul_chat_access")
      .select("id,expires_at,source")
      .eq("telegram_user_id", Number(telegramUserId))
      .gte("expires_at", nowIso)
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dayAccess) {
      return { allowed: true, source: dayAccess.source, expires_at: dayAccess.expires_at };
    }

    // 3. Подарочные сутки — первый раз бесплатно (через user_trials)
    const trialKey = "soul_chat_1day_gift";
    const { data: trialRow } = await supabase
      .from("user_trials")
      .select("id")
      .eq("telegram_user_id", Number(telegramUserId))
      .eq("trial_key", trialKey)
      .maybeSingle();
    if (!trialRow) {
      // Триал ещё не использован — предлагаем подарок
      return { allowed: false, trial_available: true, source: "gift_available",
        reason: "Тебя ждёт подарок — бесплатные сутки Soul Chat 🎁" };
    }
  }

  return {
    allowed: false,
    trial_available: false,
    reason: "Доступ к Soul Chat на 24 часа — 2.99 USDT.",
  };
}

async function activateSoulChatGift(telegramUserId) {
  if (!supabase) return { ok: false, error: "Supabase недоступен" };
  const trialKey = "soul_chat_1day_gift";
  // Записываем использование триала
  const { error: trialErr } = await supabase.from("user_trials").insert({
    telegram_user_id: Number(telegramUserId),
    trial_key: trialKey,
    consumed_at: new Date().toISOString(),
  });
  if (trialErr && /duplicate key/i.test(trialErr.message)) {
    return { ok: false, error: "Подарок уже был активирован" };
  }
  // Создаём суточный доступ
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("soul_chat_access").insert({
    telegram_user_id: Number(telegramUserId),
    expires_at: expiresAt,
    source: "gift_1day",
  });
  return { ok: true, expires_at: expiresAt, source: "gift_1day" };
}

async function activateSoulChatDay(telegramUserId, orderId) {
  if (!supabase) return { ok: false, error: "Supabase недоступен" };
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await supabase.from("soul_chat_access").insert({
    telegram_user_id: Number(telegramUserId),
    expires_at: expiresAt,
    source: "purchase_1day",
    order_id: orderId || null,
  });
  return { ok: true, expires_at: expiresAt, source: "purchase_1day" };
}

async function getRequestForSoulChat(requestId) {
  if (!supabase) return { error: "Supabase недоступен" };
  const { data: row, error } = await supabase
    .from("track_requests")
    .select("id,telegram_user_id,name,gender,birthdate,birthplace,birthtime,birthtime_unknown,mode,request,person2_name,person2_gender,person2_birthdate,person2_birthplace,transit_date,transit_time,transit_location,transit_intent")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !row) return { error: error?.message || "Заявка не найдена" };

  const { data: astro } = await supabase
    .from("astro_snapshots")
    .select("snapshot_text,snapshot_json")
    .eq("track_request_id", requestId)
    .maybeSingle();
  return { row, astro: astro || null };
}

function buildSoulChatPrompt(row, astro, question) {
  const astroText = astro?.snapshot_text || "Нет астро-данных.";
  const astroJson = astro?.snapshot_json && typeof astro.snapshot_json === "object"
    ? JSON.stringify(astro.snapshot_json).slice(0, 12000)
    : "";
  return [
    `Ты — голос души ${row.name || "человека"}.`,
    "Ты знаешь натальную карту, даши, транзиты и контекст запроса.",
    "Отвечай коротко и тепло как внутренний друг.",
    "Без инструкций, без морализаторства, без астрологических терминов.",
    "Никаких общих фраз. Только персональный ответ по данным ниже.",
    "",
    `Профиль: ${row.name || "—"} (${row.gender || "—"}), ${row.birthdate || "—"}, ${row.birthplace || "—"}, режим: ${row.mode || "single"}.`,
    row.person2_name ? `Пара: ${row.name || "—"} + ${row.person2_name} (${row.person2_gender || "—"}).` : "",
    row.transit_date || row.transit_location ? `Транзит: ${row.transit_date || "—"} ${row.transit_time || ""}, ${row.transit_location || "—"}, намерение: ${row.transit_intent || "—"}.` : "",
    `Исходный запрос: ${row.request || "—"}`,
    "",
    "Астро-снимок (текст):",
    astroText,
    astroJson ? `\nАстро-снимок (json): ${astroJson}` : "",
    "",
    `Вопрос: "${question}"`,
  ].filter(Boolean).join("\n");
}

async function runSoulChat({ requestId, question, telegramUserId, isAdminCaller = false }) {
  let rid = String(requestId || "").trim();
  const q = String(question || "").trim();
  if (!q) return { ok: false, error: "Пустой вопрос" };
  // Если request_id не передан или невалиден — ищем последнюю заявку пользователя
  if (!rid || !UUID_REGEX.test(rid)) {
    rid = (telegramUserId ? await getLastCompletedRequestForUser(telegramUserId) : null) || "";
  }
  if (!rid || !UUID_REGEX.test(rid)) {
    return { ok: false, error: "Нет заявки для чата. Сначала создай звуковой ключ в приложении." };
  }

  const loaded = await getRequestForSoulChat(rid);
  if (loaded.error) return { ok: false, error: loaded.error };
  const { row, astro } = loaded;

  if (!isAdminCaller && Number(row.telegram_user_id) !== Number(telegramUserId)) {
    return { ok: false, error: "Нет доступа к этой заявке" };
  }

  const soulPrompt = buildSoulChatPrompt(row, astro, q);
  const llm = await chatCompletion(
    "Ты этичный и тёплый собеседник. Отвечай 3-6 предложениями, конкретно и бережно. Не используй астрологические термины.",
    soulPrompt,
    { model: process.env.DEEPSEEK_MODEL || "deepseek-reasoner", max_tokens: 1200, temperature: 1.1 }
  );
  if (!llm.ok) return { ok: false, error: llm.error || "Ошибка генерации soul-chat" };
  const answer = String(llm.text || "").trim();

  // Сохраняем в историю soul_chat_sessions
  if (supabase) {
    const access = isAdminCaller ? null : await getSoulChatAccess(telegramUserId);
    supabase.from("soul_chat_sessions").insert({
      telegram_user_id: Number(telegramUserId),
      track_request_id: rid,
      question: q,
      answer,
      source: access?.source || "admin",
    }).then(() => {}).catch(() => {});
  }

  return { ok: true, answer, request: row };
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
  if (data.birthplaceLat != null && data.birthplaceLon != null) {
    row.birthplace_lat = Number(data.birthplaceLat);
    row.birthplace_lon = Number(data.birthplaceLon);
  }
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

// Кнопки приложения:
// 1. Menu Button (слева от поля ввода) — setChatMenuButton()
// 2. Кнопка "Открыть" (рядом с ботом в списке чатов) — setWebhook() с web_app параметром
// На Render часто забывают MINI_APP_URL, и Telegram продолжает открывать старый домен (404).
// Поэтому авто-фиксируем обе кнопки на MINI_APP_URL при старте бота и в команде /fixurl.

// Отправляет пользователю сообщение с кнопками "Оплатить" / "Отменить" когда заявка не оплачена.
async function sendPendingPaymentBotMessage(telegramUserId, requestId) {
  // Используем СТАБИЛЬНЫЙ URL (без timestamp) — кнопки в сообщениях живут дольше одного деплоя
  const payUrl = MINI_APP_STABLE_URL + "?requestId=" + encodeURIComponent(requestId);
  const shortId = String(requestId || "").substring(0, 8);
  try {
    await bot.api.sendMessage(
      telegramUserId,
      `⏳ *Заявка создана, но ожидает оплаты*\n\nID: \`${shortId}\`\n\nВыбери действие:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Оплатить сейчас", web_app: { url: payUrl } }],
            [{ text: "❌ Отменить заявку", callback_data: "cancel_req:" + requestId }],
          ],
        },
      }
    );
  } catch (e) {
    console.warn("[PendingPayment] Не удалось отправить сообщение пользователю:", e?.message);
  }
}

// Обработчик нажатия кнопки "Отменить заявку"
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  if (!data.startsWith("cancel_req:")) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const requestId = data.slice("cancel_req:".length).trim();
  const callerId = ctx.from?.id;
  if (supabase && requestId && callerId) {
    // Отменяем только если заявка принадлежит этому пользователю
    await supabase
      .from("track_requests")
      .update({ generation_status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", requestId)
      .eq("telegram_user_id", callerId)
      .catch((e) => console.warn("[cancel_req] supabase error:", e?.message));
  }
  await ctx.answerCallbackQuery({ text: "✅ Заявка отменена" }).catch(() => {});
  try {
    await ctx.editMessageText(
      `❌ *Заявка отменена*\n\nID: \`${String(requestId).substring(0, 8)}\`\n\nЕсли передумаешь — открой приложение и создай новую заявку.`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.warn("[cancel_req] editMessageText:", e?.message);
  }
});

bot.command("ping", async (ctx) => {
  console.log("[Bot] Команда /ping от пользователя:", ctx.from?.username, ctx.from?.id);
  await ctx.reply("🟢 Бот на связи. Команды работают.\n\n" +
                  "📊 Статус:\n" +
                  "• Webhook: " + (WEBHOOK_URL ? "активен" : "отключен") + "\n" +
                  "• Время: " + new Date().toISOString());
});

bot.command("fixurl", async (ctx) => {
  const name = ctx.from?.first_name || "друг";
  try {
    // Обновляем menu button для этого чата (per-chat)
    await bot.api.setChatMenuButton({
      chat_id: ctx.chat?.id,
      menu_button: { type: "web_app", text: "YupSoul", web_app: { url: MINI_APP_URL } },
    });

    // Обновляем глобальный menu button (для всех новых чатов)
    await bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "YupSoul", web_app: { url: MINI_APP_URL } },
    });
    
    // Отправляем НОВОЕ сообщение с кнопкой — это обновит "Открыть" в списке чатов Telegram.
    // Кнопка "Открыть" в превью чата = web_app кнопка из ПОСЛЕДНЕГО сообщения бота.
    // Используем стабильный URL (без timestamp) чтобы кнопка работала после следующего деплоя.
    await ctx.reply(
      `✅ *${name}, ссылки обновлены!*\n\n` +
      `Кнопка *YupSoul* в меню чата теперь ведёт на рабочее приложение.\n\n` +
      `Также нажми кнопку ниже — это обновит "Открыть" в списке чатов Telegram:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🎵 Открыть YupSoul", web_app: { url: MINI_APP_STABLE_URL } }
          ]]
        }
      }
    );
    console.log("[fixurl] Menu Button обновлён для chat", ctx.chat?.id, "и глобально →", MINI_APP_URL);
  } catch (err) {
    await ctx.reply(`❌ Ошибка при обновлении кнопок: ${err?.message}`);
    console.error("[fixurl] Ошибка:", err);
  }
});

bot.command("start", async (ctx) => {
  const name = ctx.from?.first_name || "друг";
  const text =
    `Привет, ${name}!\n\n` +
    `Заходи, когда захочешь вспомнить, кто ты.\n\n` +
    `Открой мини‑приложение и создай свой персональный звуковой ключ.`;
  
  // Принудительно обновляем Menu Button при каждом /start, чтобы избежать старых Vercel-ссылок
  try {
    await bot.api.setChatMenuButton({
      chat_id: ctx.chat?.id,
      menu_button: { type: "web_app", text: "YupSoul", web_app: { url: MINI_APP_URL } },
    });
    console.log("[start] Menu Button обновлён для chat", ctx.chat?.id, "→", MINI_APP_URL);
  } catch (menuErr) {
    console.warn("[start] Не удалось обновить Menu Button:", menuErr?.message);
  }
  
  const replyMarkup = {
    reply_markup: {
      inline_keyboard: [[
        // Стабильный URL (без timestamp) — кнопка в сообщениях живёт после следующих деплоев
        { text: "🎵 Открыть YupSoul", web_app: { url: MINI_APP_STABLE_URL } }
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

  const access = await resolveAccessForRequest({ telegramUserId, mode: "single" });
  if (!access.allowed) {
    const skuPrice = await getSkuPrice(access.sku);
    await supabase?.from("track_requests").update({
      payment_provider: "hot",
      payment_status: "requires_payment",
      payment_amount: skuPrice ? Number(skuPrice.price) : null,
      payment_currency: skuPrice?.currency || "USDT",
      generation_status: "pending_payment",
      updated_at: new Date().toISOString(),
    }).eq("id", requestId);
    await sendPendingPaymentBotMessage(telegramUserId, requestId);
    return;
  }
  if (access.source === "trial") {
    const consumed = await consumeTrial(telegramUserId, "first_song_gift");
    if (!consumed.ok) {
      const skuPrice = await getSkuPrice(access.sku);
      await supabase?.from("track_requests").update({
        payment_provider: "hot",
        payment_status: "requires_payment",
        payment_amount: skuPrice ? Number(skuPrice.price) : null,
        payment_currency: skuPrice?.currency || "USDT",
        generation_status: "pending_payment",
        updated_at: new Date().toISOString(),
      }).eq("id", requestId);
      await sendPendingPaymentBotMessage(telegramUserId, requestId);
      return;
    }
  }
  await supabase?.from("track_requests").update({
    payment_provider: access.source === "trial" ? "gift" : (access.source === "subscription" ? "subscription" : "hot"),
    payment_status: access.source === "trial" ? "gift_used" : (access.source === "subscription" ? "subscription_active" : "paid"),
    updated_at: new Date().toISOString(),
  }).eq("id", requestId);

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

bot.command("soulchat", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Не удалось определить пользователя.");
    return;
  }
  if (!supabase) {
    await ctx.reply("❌ База данных недоступна.");
    return;
  }
  const args = ctx.message?.text?.trim()?.split(/\s+/)?.slice(1) || [];
  let requestId = args.length ? String(args[0] || "").trim() : null;
  if (!requestId) {
    requestId = await getLastCompletedRequestForUser(userId);
    if (!requestId) {
      await ctx.reply("У тебя пока нет готового звукового ключа. Сначала создай его в приложении — затем сможешь задать вопрос своей душе.");
      return;
    }
  }
  const loaded = await getRequestForSoulChat(requestId);
  if (loaded.error) {
    await ctx.reply(`❌ ${loaded.error}`);
    return;
  }
  if (!isAdmin(userId) && Number(loaded.row.telegram_user_id) !== Number(userId)) {
    await ctx.reply("🚫 Эта заявка принадлежит другому пользователю.");
    return;
  }
  pendingSoulChatByUser.set(Number(userId), { requestId, startedAt: Date.now() });
  const req = loaded.row;
  await ctx.reply(`Задай вопрос своей душе — напиши его следующим сообщением.\n\nПрофиль: ${req.name || "—"}${req.person2_name ? ` + ${req.person2_name}` : ""}`);
});

bot.on("message:text", async (ctx, next) => {
  const userId = Number(ctx.from?.id || 0);
  const text = (ctx.message?.text || "").trim();
  if (!userId || !pendingSoulChatByUser.has(userId)) return next();
  if (!text || text.startsWith("/")) return next();

  const pending = pendingSoulChatByUser.get(userId);
  pendingSoulChatByUser.delete(userId);
  await ctx.reply("🧘 Слушаю душу... готовлю ответ.");
  const result = await runSoulChat({
    requestId: pending.requestId,
    question: text,
    telegramUserId: userId,
    isAdminCaller: isAdmin(userId),
  });
  if (!result.ok) {
    await ctx.reply(`❌ ${result.error}`);
    return;
  }
  await ctx.reply(`💬 Ответ души для ${result.request?.name || "тебя"}:\n\n${result.answer}`);
});

// Любая неизвестная команда — подсказка (чтобы не было «пустого» отклика)
bot.on("message:text", async (ctx, next) => {
  const text = (ctx.message?.text || "").trim();
  if (!text.startsWith("/")) return next();
  const cmd = text.split(/\s/)[0].toLowerCase();
  if (["/start", "/ping", "/get_analysis", "/admin", "/admin_check", "/astro", "/full_analysis", "/soulchat"].includes(cmd)) return next();
  await ctx.reply("Неизвестная команда. Доступны: /start, /ping, /get_analysis, /soulchat <id>. Админам: /admin, /admin_check, /astro <id>, /full_analysis <id>.");
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
    const sep = "?";
    const token = ADMIN_SECRET ? "token=" + encodeURIComponent(ADMIN_SECRET) : "";
    const apiOrigin = "api_origin=" + encodeURIComponent(BOT_PUBLIC_URL);
    const query = [token, apiOrigin].filter(Boolean).join("&");
    return BOT_PUBLIC_URL + "/admin" + (query ? sep + query : "");
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
      console.warn("[admin] Нет chat/from в апдейте");
      try {
        await ctx.reply("Не удалось определить чат. Напиши /admin в личку боту (открой чат с ботом и отправь команду там).");
      } catch (_) {}
      return;
    }
    console.log("[admin] chatId=" + chatId + " userId=" + userId + " isAdmin=" + isAdmin(userId) + " ADMIN_IDS=" + JSON.stringify(ADMIN_IDS));

    if (!ADMIN_IDS.length) {
      await reply("В Render (Environment) не задан ADMIN_TELEGRAM_IDS. Добавь: ADMIN_TELEGRAM_IDS=твой_Telegram_ID (узнать ID: @userinfobot), затем перезапусти сервис.");
      sendAdminLink();
      return;
    }
    if (!isAdmin(userId)) {
      await reply("Нет доступа к админке. Твой Telegram ID: " + (userId ?? "?") + ". Добавь в Render → Environment: ADMIN_TELEGRAM_IDS=" + (userId ?? "ТВОЙ_ID") + " и перезапусти бота.");
      return;
    }

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
    console.error("[admin] Ошибка:", err?.message || err);
    replyAny("Ошибка при выполнении /admin. Попробуй /admin_check или подожди минуту (сервер мог проснуться) и напиши /admin снова.");
    sendAdminLink();
  }
});

// Регистрация команд в Telegram (меню бота)
const commands = [
  { command: "start", description: "Начать / открыть приложение" },
  { command: "ping", description: "Проверка связи с ботом" },
  { command: "fixurl", description: "Исправить все ссылки на мини-приложение (меню + кнопка 'Открыть')" },
  { command: "get_analysis", description: "Расшифровка карты (после оплаты)" },
  { command: "soulchat", description: "Разговор по душам по заявке" },
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
// Базовый URL для ссылки на админку. Одинаковое значение с WEBHOOK_URL — нормально (один сервис = один URL).
const BOT_PUBLIC_URL = (process.env.BOT_PUBLIC_URL || process.env.WEBHOOK_URL || process.env.HEROES_API_BASE || "").replace(/\/webhook\/?$/i, "").replace(/\/$/, "");

// КРИТИЧНО: Обработчик webhook для Telegram бота.
// express.json() обязателен ДО webhookCallback — иначе req.body пустой и grammY падает с "reading 'update_id'".
if (WEBHOOK_URL) {
  console.log("[Bot] Настройка webhook обработчика для пути /webhook");
  app.post("/webhook", express.json(), (req, res, next) => {
    if (!req.body || typeof req.body !== "object") {
      console.warn("[Webhook] Пустое или не-JSON body, отвечаем 400");
      return res.status(400).send("Bad Request");
    }
    if (req.body.update_id == null) {
      console.warn("[Webhook] Нет update_id в body, отвечаем 400");
      return res.status(400).send("Bad Request");
    }
    console.log("[Webhook] update_id:", req.body.update_id);
    next();
  }, webhookCallback(bot, "express"));
  console.log("[Bot] Webhook обработчик установлен для /webhook");
} else {
  console.log("[Bot] WEBHOOK_URL не задан, webhook обработчик не установлен");
}
// HOT webhook: верификация подписи (X-HOT-Signature), идемпотентность по payment_order_id и payment_tx_id
app.post("/api/payments/hot/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
    const signature = req.headers["x-hot-signature"] || req.headers["x-signature"] || "";
    if (!verifyHotWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ success: false, error: "Invalid webhook signature" });
    }
    const body = parseJsonSafe(rawBody, {});
    // HOT присылает memo (см. Webhook Payload Example), order_id может отсутствовать.
    const orderId = String(body.memo || body.order_id || body.orderId || body.data?.order_id || "").trim();
    const requestId = String(body.request_id || body.requestId || body.data?.request_id || body.data?.requestId || "").trim();
    const status = String(body.payment_status || body.status || body.event || "").toLowerCase();
    const txId = String(body.tx_id || body.txId || body.near_trx || body.transaction_id || body.data?.tx_id || "").trim() || null;
    if (!orderId && !requestId) return res.status(400).json({ success: false, error: "memo/order_id or request_id is required" });
    if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });

    // 1) Основной поиск: по payment_order_id (memo). 2) Фолбек: по request_id (если HOT прислал не memo).
    let row = null;
    let rowErr = null;
    if (orderId) {
      const r1 = await supabase
        .from("track_requests")
        .select("id,telegram_user_id,payment_status,payment_order_id,mode,payment_raw,payment_tx_id,generation_status,status")
        .eq("payment_order_id", orderId)
        .maybeSingle();
      row = r1.data || null;
      rowErr = r1.error || null;
    }
    if (rowErr) return res.status(500).json({ success: false, error: rowErr.message });
    if (!row && requestId) {
      const r2 = await supabase
        .from("track_requests")
        .select("id,telegram_user_id,payment_status,payment_order_id,mode,payment_raw,payment_tx_id,generation_status,status")
        .eq("id", requestId)
        .maybeSingle();
      if (r2.error) return res.status(500).json({ success: false, error: r2.error.message });
      row = r2.data || null;
    }
    if (!row) return res.status(404).json({ success: false, error: "Order not found" });
    if ((row.payment_status || "").toLowerCase() === "paid") return res.json({ success: true, message: "Already processed" });

    const normalizedPaid = ["paid", "success", "completed", "confirmed"].includes(status);
    const paymentStatus = normalizedPaid ? "paid" : (status || "pending");
    const paymentAmount = body.amount != null ? Number(body.amount) : null;
    const paymentCurrency = String(body.currency || "USDT");
    const webhookSku = String(body.sku || body.item_sku || body.data?.sku || "").trim();
    const fallbackSku = String(parseJsonSafe(row.payment_raw, {})?.sku || "").trim();
    const purchasedSku = webhookSku || fallbackSku || resolveSkuByMode(row.mode);

    if (txId) {
      const { data: txRow, error: txErr } = await supabase
        .from("track_requests")
        .select("id,payment_status")
        .eq("payment_tx_id", txId)
        .neq("id", row.id)
        .maybeSingle();
      if (!txErr && txRow && String(txRow.payment_status || "").toLowerCase() === "paid") {
        return res.json({ success: true, message: "Duplicate tx ignored" });
      }
    }

    const updatePayload = {
      payment_provider: "hot",
      payment_status: paymentStatus,
      ...(orderId && (!row.payment_order_id || String(row.payment_order_id).trim() !== orderId) ? { payment_order_id: orderId } : {}),
      payment_tx_id: txId,
      payment_amount: Number.isFinite(paymentAmount) ? paymentAmount : null,
      payment_currency: paymentCurrency,
      payment_raw: { ...parseJsonSafe(row.payment_raw, {}) || {}, ...body, sku: purchasedSku },
      paid_at: normalizedPaid ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    // Идемпотентность: обновляем только если заказ ещё не в статусе paid (защита от двойного grant при повторных webhook)
    const { data: updatedRow, error: updErr } = await supabase
      .from("track_requests")
      .update(updatePayload)
      .eq("id", row.id)
      .or("payment_status.is.null,payment_status.neq.paid")
      .select("id")
      .maybeSingle();
    if (updErr && !/does not exist|column/i.test(updErr.message)) return res.status(500).json({ success: false, error: updErr.message });
    if (!updatedRow) return res.json({ success: true, message: "Already processed" });

    if (normalizedPaid) {
      const promoFromOrder = String(parseJsonSafe(row.payment_raw, {})?.promo_code || "").trim();
      if (promoFromOrder) {
        const promoObj = await getPromoByCode(promoFromOrder);
        if (promoObj) {
          await redeemPromoUsage({
            promo: promoObj,
            telegramUserId: row.telegram_user_id,
            requestId: row.id,
            orderId,
            discountAmount: Number(parseJsonSafe(row.payment_raw, {})?.discount_amount || 0),
          });
        }
      }
      await grantPurchaseBySku({ telegramUserId: row.telegram_user_id, sku: purchasedSku, source: "hot_payment", orderId: orderId || null });

      // Специальная обработка для Soul Chat 1day
      if (purchasedSku === "soul_chat_1day") {
        const dayGrant = await activateSoulChatDay(row.telegram_user_id, orderId);
        const expiresStr = dayGrant.ok && dayGrant.expires_at
          ? ` Доступ действует до: ${new Date(dayGrant.expires_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} (МСК)`
          : "";
        const shortId = String(row.id || "").slice(0, 8);
        bot.api.sendMessage(
          row.telegram_user_id,
          `✅ *Soul Chat активирован!*\n\n💬 24 часа общения с душой открыты.${expiresStr}\n\nОткрой YupSoul и задавай вопросы — я здесь ✨`,
          { parse_mode: "Markdown" }
        ).catch((e) => console.warn("[webhook] notify soul chat user:", e?.message));
        for (const adminId of ADMIN_IDS) {
          bot.api.sendMessage(
            adminId,
            `💰 *Soul Chat куплен*\nЗаявка: \`${shortId}\`\nСумма: ${body.amount || "?"} ${body.currency || "USDT"}`
          , { parse_mode: "Markdown" }).catch(() => {});
        }
      } else {
        // Обычный звуковой ключ
        const gs = String(row.generation_status || row.status || "pending");
        if (["pending_payment", "pending", "processing"].includes(gs)) {
          import("./workerSoundKey.js").then(({ generateSoundKey }) => {
            generateSoundKey(row.id).catch((err) => console.error("[payments/hot/webhook] generate:", err?.message || err));
          }).catch((err) => console.error("[payments/hot/webhook] import worker:", err?.message || err));
        }

        // Уведомляем пользователя в Telegram что оплата принята и заявка в работе
        const shortId = String(row.id || "").slice(0, 8);
        bot.api.sendMessage(
          row.telegram_user_id,
          `✅ *Оплата подтверждена!*\n\nЗаявка ID: \`${shortId}\` принята в работу.\n🎵 Твой звуковой ключ создаётся — отправлю, как только будет готово!`,
          { parse_mode: "Markdown" }
        ).catch((e) => console.warn("[webhook] notify user paid:", e?.message));

        // Уведомляем администраторов
        for (const adminId of ADMIN_IDS) {
          bot.api.sendMessage(
            adminId,
            `💰 *Оплата получена*\nЗаявка: \`${shortId}\`\nСумма: ${body.amount || "?"} ${body.currency || "USDT"}\nSKU: ${purchasedSku}`
          , { parse_mode: "Markdown" }).catch(() => {});
        }
      }
    }
    return res.json({ success: true, paid: normalizedPaid, sku: purchasedSku });
  } catch (e) {
    return res.status(500).json({ success: false, error: e?.message || "Webhook error" });
  }
});
app.use(express.json());
// Логирование всех входящих запросов для диагностики
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[REQUEST] ${timestamp} ${req.method} ${req.path} query:${JSON.stringify(req.query)}`);
  next();
});
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init, X-Admin-Token, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// Health check: и для Render, и для «пробуждения» в браузере — показываем страницу, а не пустой/серый экран
const healthHtml =
  "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>YupSoul Bot</title><style>body{font-family:sans-serif;padding:2rem;max-width:32rem;margin:0 auto;} a{margin:0 .25rem}</style></head><body><h1>Сервис работает</h1><p>Бот пробуждён — можно писать ему в Telegram.</p><p><a href=\"/\">Главная</a> · <a href=\"/admin\">Админка</a></p></body></html>";
app.get("/healthz", (_req, res) =>
  res.status(200).set("Content-Type", "text/html; charset=utf-8").send(healthHtml)
);
// Эндпоинт для проверки URL Mini App (для кнопки в Telegram)
app.get("/api/miniapp-url", (_req, res) => {
  res.json({
    ok: true,
    url: MINI_APP_URL,
    base: MINI_APP_BASE,
    message: "Используй url в качестве Web App URL в кнопке меню бота.",
  });
});
// Mini App: корень / и /app — чтобы работало при любом URL в кнопке меню
const publicDir = path.join(__dirname, "public");
const appHtmlPath = path.join(publicDir, "index.html");
function serveMiniApp(req, res) {
  // Серверный 302-редирект: если v=22 (старый короткий номер) → отправляем на свежий timestamp
  const vParam = req.query.v;
  if (vParam && /^\d{1,9}$/.test(String(vParam))) {
    console.log(`[serveMiniApp] Старый v=${vParam} → редирект на v=${APP_BUILD}`);
    return res.redirect(302, `/app?v=${APP_BUILD}`);
  }
  // Запрет кеширования HTML
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  try {
    res.setHeader("X-MiniApp-Build", String(APP_BUILD));
    res.setHeader("X-Render-Commit", process.env.RENDER_GIT_COMMIT || "");
  } catch (_) {}
  res.sendFile(appHtmlPath, (err) => {
    if (err) {
      console.error("[serveMiniApp] Ошибка отправки файла:", err);
      res.status(404).send("Mini App не найден. Проверь деплой и папку public.");
    } else {
      console.log("[serveMiniApp] Файл успешно отправлен");
    }
  });
}
app.get(["/", "/app", "/app/"], serveMiniApp);
app.use("/", express.static(publicDir, { index: false }));
app.use("/app", express.static(publicDir, { index: false }));
// Обработчик /api/me (чтобы не было 500 ошибки)
app.get("/api/me", (_req, res) => {
  res.json({ ok: true, user: null, authenticated: false });
});

// Профиль пользователя — автовход, предзаполнение формы
app.post("/api/user/profile", express.json(), asyncApi(async (req, res) => {
  const initData = req.body?.initData ?? req.headers["x-telegram-init"];
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) {
    return res.status(401).json({ error: "Неверные данные авторизации. Открой приложение из чата с ботом." });
  }
  if (!supabase) return res.status(503).json({ error: "База недоступна" });
  const body = req.body || {};
  const profileData = {};
  if (body.name != null) profileData.name = body.name;
  if (body.birthdate != null) profileData.birthdate = body.birthdate;
  if (body.birthplace != null) profileData.birthplace = body.birthplace;
  if (body.birthtime != null) profileData.birthtime = body.birthtime;
  if (body.birthtime_unknown != null) profileData.birthtime_unknown = !!body.birthtime_unknown;
  if (body.gender != null) profileData.gender = body.gender;
  if (body.language != null) profileData.language = body.language;
  if (Object.keys(profileData).length > 0) {
    profileData.telegram_id = telegramUserId;
    profileData.updated_at = new Date().toISOString();
    const { error } = await supabase.from("user_profiles").upsert(profileData, { onConflict: "telegram_id" });
    if (error && /does not exist|relation/i.test(error.message)) {
      return res.json({ profile: null, message: "Таблица user_profiles не создана. Выполни миграцию bot/supabase-migration-user-profiles.sql" });
    }
    if (error) return res.status(500).json({ error: error.message });
  }
  const { data, error } = await supabase.from("user_profiles").select("*").eq("telegram_id", telegramUserId).maybeSingle();
  if (error && /does not exist|relation/i.test(error.message)) return res.json({ profile: null });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ profile: data || null });
}));

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

app.get(["/admin", "/admin/"], (req, res) => {
  res.type("html").sendFile(path.join(__dirname, "admin-simple.html"), (err) => {
    if (err) {
      console.error("[admin] sendFile error:", err.message);
      res.status(500).send("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Ошибка</title></head><body style='background:#0f0f1b;color:#fff;font-family:sans-serif;padding:40px;'><p>Файл админки не найден.</p><p><a href='/'>На главную</a></p></body></html>");
    }
  });
});

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
  const stats = { total: rows.length, pending: 0, pending_payment: 0, cancelled: 0, astro_calculated: 0, lyrics_generated: 0, suno_processing: 0, completed: 0, failed: 0 };
  rows.forEach((r) => {
    const s = (r.generation_status ?? r.status) || "pending";
    if (s === "completed") stats.completed++;
    else if (s === "failed") stats.failed++;
    else if (s === "cancelled") stats.cancelled++;
    else if (s === "pending_payment") stats.pending_payment++;
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
  const fullSelect = "id,name,gender,birthdate,birthplace,person2_name,person2_gender,person2_birthdate,person2_birthplace,status,generation_status,created_at,audio_url,mode,request,generation_steps,payment_status,payment_provider,telegram_user_id";
  let q = supabase.from("track_requests").select(fullSelect).order("created_at", { ascending: false }).limit(limit);
  if (statusFilter === "pending") q = q.in("generation_status", ["pending", "astro_calculated", "lyrics_generated", "suno_processing"]);
  else if (statusFilter === "pending_payment") q = q.eq("generation_status", "pending_payment");
  else if (statusFilter === "completed") q = q.eq("generation_status", "completed");
  else if (statusFilter === "failed") q = q.eq("generation_status", "failed");
  else if (statusFilter === "cancelled") q = q.eq("generation_status", "cancelled");
  // "all" — без фильтра
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
  const fullCols = "id,name,gender,birthdate,birthplace,birthtime,birthtime_unknown,mode,person2_name,person2_gender,person2_birthdate,person2_birthplace,person2_birthtime,person2_birthtime_unknown,transit_date,transit_time,transit_location,transit_intent,deepseek_response,lyrics,audio_url,request,created_at,status,generation_status,error_message,llm_truncated,generation_steps,payment_status,payment_provider,telegram_user_id";
  const coreCols = "id,name,gender,birthdate,birthplace,birthtime,birthtime_unknown,mode,person2_name,person2_gender,person2_birthdate,person2_birthplace,person2_birthtime,person2_birthtime_unknown,transit_date,transit_time,transit_location,transit_intent,deepseek_response,lyrics,audio_url,request,created_at,status,generation_status,error_message";
  const minCols = "id,name,gender,birthdate,birthplace,request,created_at,status,telegram_user_id";
  let usedFallbackCols = false;
  let result = await supabase.from("track_requests").select(fullCols).eq("id", id).maybeSingle();
  // Если отсутствуют "новые" колонки (например generation_steps), пробуем "core" набор, где есть deepseek_response.
  if (result.error && /does not exist|column/i.test(result.error.message)) {
    result = await supabase.from("track_requests").select(coreCols).eq("id", id).maybeSingle();
    usedFallbackCols = true;
  }
  // Только если и core не читается — падаем до минимального набора (без deepseek_response).
  if (result.error && /does not exist|column/i.test(result.error.message)) {
    result = await supabase.from("track_requests").select(minCols).eq("id", id).maybeSingle();
    usedFallbackCols = true;
  }
  if (result.error) return res.status(500).json({ success: false, error: result.error.message });
  if (!result.data) return res.status(404).json({ success: false, error: "Заявка не найдена" });
  const row = result.data;
  let astroSnapshotText = null;
  let astroSnapshotJson = null;
  try {
    const astro = await supabase
      .from("astro_snapshots")
      .select("snapshot_text,snapshot_json")
      .eq("track_request_id", id)
      .maybeSingle();
    if (!astro.error && astro.data) {
      astroSnapshotText = astro.data.snapshot_text || null;
      astroSnapshotJson = astro.data.snapshot_json || null;
    }
  } catch (_) {}
  const deepseekText = typeof row.deepseek_response === "string" ? row.deepseek_response.trim() : "";
  const hasDeepseekResponse = deepseekText.length > 0;
  const gs = row.generation_status || row.status || "pending";
  let deepseekMissingReason = null;
  if (!hasDeepseekResponse) {
    if (usedFallbackCols && (row.deepseek_response === undefined || row.deepseek_response === null)) deepseekMissingReason = "column_missing_or_old_schema";
    else if (gs === "failed") deepseekMissingReason = "generation_failed";
    else if (["pending", "processing", "astro_calculated", "lyrics_generated", "suno_processing"].includes(gs)) deepseekMissingReason = "generation_in_progress";
    else if (gs === "completed") deepseekMissingReason = "completed_without_deepseek_response";
    else deepseekMissingReason = "not_generated";
  }
  return res.json({
    success: true,
    data: {
      ...row,
      astro_snapshot_text: astroSnapshotText,
      astro_snapshot_json: astroSnapshotJson,
      has_deepseek_response: hasDeepseekResponse,
      deepseek_missing_reason: deepseekMissingReason,
    },
  });
}));

app.post("/api/admin/requests/:id/restart", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const id = sanitizeRequestId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: "Неверный ID заявки" });
  if (!isValidRequestId(id)) return res.status(400).json({ success: false, error: "Используйте полный UUID заявки (с дефисами), не обрезанный ID" });
  const { data: row } = await supabase.from("track_requests").select("payment_status").eq("id", id).maybeSingle();
  const ps = String(row?.payment_status || "").toLowerCase();
  const needsPaymentOverride = ["pending", "requires_payment"].includes(ps);
  const updatePayload = {
    status: "pending",
    generation_status: "pending",
    error_message: null,
    updated_at: new Date().toISOString(),
  };
  if (needsPaymentOverride) updatePayload.payment_status = "paid";
  const { error: updateError } = await supabase
    .from("track_requests")
    .update(updatePayload)
    .eq("id", id);
  if (updateError) return res.status(500).json({ success: false, error: updateError.message });
  import("./workerSoundKey.js").then(({ generateSoundKey }) => {
    generateSoundKey(id).catch((err) => console.error("[admin] restart generateSoundKey:", err?.message || err));
  }).catch((err) => console.error("[admin] restart import workerSoundKey:", err?.message || err));
  return res.json({ success: true, message: "Перезапущено" });
}));

app.post("/api/admin/requests/:id/mark-paid", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const id = sanitizeRequestId(req.params.id);
  if (!id || !isValidRequestId(id)) return res.status(400).json({ success: false, error: "Неверный ID заявки" });
  const { error: updErr } = await supabase
    .from("track_requests")
    .update({
      payment_status: "paid",
      payment_provider: req.body?.provider || "admin",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updErr) return res.status(500).json({ success: false, error: updErr.message });
  return res.json({ success: true, message: "Заявка отмечена как оплаченная" });
}));

app.post("/api/admin/requests/:id/deliver", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const id = sanitizeRequestId(req.params.id);
  if (!id || !isValidRequestId(id)) return res.status(400).json({ success: false, error: "Неверный ID заявки" });
  const { data, error } = await supabase
    .from("track_requests")
    .select("id,name,telegram_user_id,audio_url,cover_url,title")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ success: false, error: "Заявка не найдена" });
  const { telegram_user_id, audio_url, cover_url, title, name } = data;
  if (!telegram_user_id) return res.status(400).json({ success: false, error: "Нет telegram_user_id" });
  if (!audio_url) return res.status(400).json({ success: false, error: "Нет аудио (audio_url)" });
  if (!BOT_TOKEN) return res.status(503).json({ success: false, error: "BOT_TOKEN не настроен" });
  const caption = `🗝️ ${name || "Друг"}, твой звуковой ключ готов!\n\nЭто не просто песня — это твой персональный ключ. Слушай сердцем ❤️\n— YupSoul`;
  try {
    if (cover_url) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          chat_id: String(telegram_user_id),
          photo: cover_url,
          caption: `Обложка · ${title || "Звуковой ключ"}`,
        }).toString(),
      });
    }
    const audioRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        chat_id: String(telegram_user_id),
        audio: audio_url,
        caption,
      }).toString(),
    });
    const audioData = await audioRes.json().catch(() => ({}));
    if (!audioData.ok) return res.status(500).json({ success: false, error: audioData.description || "Ошибка Telegram API" });
    return res.json({ success: true, message: "Песня отправлена пользователю" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e?.message || "Ошибка отправки" });
  }
}));

// Отмена заявки из админки или от пользователя через кнопку в боте
app.post("/api/admin/requests/:id/cancel", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const id = sanitizeRequestId(req.params.id);
  if (!id || !isValidRequestId(id)) return res.status(400).json({ success: false, error: "Неверный ID заявки" });
  const { error } = await supabase
    .from("track_requests")
    .update({ generation_status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true });
}));

// Массовое удаление заявок из списка (например тестовых). Только для админа.
app.post("/api/admin/requests/delete", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const raw = req.body?.ids;
  const ids = Array.isArray(raw) ? raw.map((id) => String(id).trim()).filter(Boolean).filter(isValidRequestId) : [];
  if (ids.length === 0) return res.status(400).json({ success: false, error: "Укажите массив ids (UUID заявок) для удаления" });
  const { error } = await supabase.from("track_requests").delete().in("id", ids);
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true, deleted: ids.length });
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
  const deepseek_max_tokens = settings.deepseek_max_tokens != null ? Math.min(65536, Math.max(1, Number(settings.deepseek_max_tokens))) : null;
  const deepseek_temperature = settings.deepseek_temperature != null ? Number(settings.deepseek_temperature) : null;
  return res.json({
    success: true,
    settings: {
      ...settings,
      deepseek_max_tokens: deepseek_max_tokens ?? undefined,
      deepseek_model: settings.deepseek_model ?? undefined,
      deepseek_temperature: (deepseek_temperature != null && Number.isFinite(deepseek_temperature)) ? deepseek_temperature : undefined,
    },
  });
}));

app.put("/api/admin/settings", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const { deepseek_max_tokens, deepseek_model, deepseek_temperature } = req.body || {};
  if (deepseek_max_tokens !== undefined) {
    const val = Math.min(65536, Math.max(1, Number(deepseek_max_tokens)));
    const { error: upsertErr } = await supabase.from("app_settings").upsert(
      { key: "deepseek_max_tokens", value: String(val), updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (upsertErr) return res.status(500).json({ success: false, error: upsertErr.message });
  }
  if (deepseek_model !== undefined) {
    const val = String(deepseek_model).trim() || null;
    const { error: upsertErr } = await supabase.from("app_settings").upsert(
      { key: "deepseek_model", value: val || "", updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (upsertErr) return res.status(500).json({ success: false, error: upsertErr.message });
  }
  if (deepseek_temperature !== undefined) {
    const num = Number(deepseek_temperature);
    const val = (Number.isFinite(num) && num >= 0 && num <= 2) ? String(num) : "1.5";
    const { error: upsertErr } = await supabase.from("app_settings").upsert(
      { key: "deepseek_temperature", value: val, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    if (upsertErr) return res.status(500).json({ success: false, error: upsertErr.message });
  }
  return res.json({ success: true, message: "Настройки сохранены" });
}));

app.get("/api/soul-chat/access", asyncApi(async (req, res) => {
  const initData = req.headers["x-telegram-init"] || req.query?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, allowed: false, reason: "Нужна авторизация Telegram." });
  const [access, lastReqId] = await Promise.all([
    getSoulChatAccess(telegramUserId),
    getLastCompletedRequestForUser(telegramUserId),
  ]);
  return res.json({
    success: true,
    allowed: !!access.allowed,
    trial_available: !!access.trial_available,
    reason: access.reason || null,
    source: access.source || null,
    expires_at: access.expires_at || null,
    last_request_id: lastReqId || null,
  });
}));

// Активировать подарочные сутки (первый раз бесплатно)
app.post("/api/soul-chat/activate-gift", express.json(), asyncApi(async (req, res) => {
  const initData = req.headers["x-telegram-init"] || (req.body && req.body.initData) || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Нужна авторизация Telegram." });
  const access = await getSoulChatAccess(telegramUserId);
  if (access.allowed) return res.json({ success: true, already_active: true, expires_at: access.expires_at, source: access.source });
  if (!access.trial_available) return res.status(403).json({ success: false, error: "Подарочные сутки уже использованы. Необходима оплата — 2.99 USDT." });
  const result = await activateSoulChatGift(telegramUserId);
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  return res.json({ success: true, expires_at: result.expires_at, source: result.source });
}));

// Создать HOT Pay ссылку для покупки суток
app.post("/api/soul-chat/buy-day", express.json(), asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || (req.body && req.body.initData) || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Нужна авторизация Telegram." });
  const sku = "soul_chat_1day";
  const price = await getSkuPrice(sku);
  if (!price) return res.status(400).json({ success: false, error: "SKU soul_chat_1day не найден. Запустите RUN_IN_SUPABASE.sql." });
  const itemId = pickHotItemId(sku);
  if (!itemId) return res.status(400).json({ success: false, error: "HOT_ITEM_ID не задан для soul_chat_1day. Добавьте HOT_ITEM_ID_SOUL_CHAT_1DAY или HOT_ITEM_ID_DEFAULT в Render." });
  const orderId = crypto.randomUUID();
  // Сохраняем pending-заказ в track_requests как служебный (без астро)
  const { data: inserted } = await supabase.from("track_requests").insert({
    telegram_user_id: Number(telegramUserId),
    name: "SoulChat",
    mode: "soul_chat_day",
    request: "Покупка суточного доступа Soul Chat",
    payment_provider: "hot",
    payment_status: "pending",
    payment_order_id: orderId,
    payment_amount: Number(price.price),
    payment_currency: price.currency || "USDT",
    generation_status: "pending_payment",
  }).select("id").maybeSingle();
  const requestId = inserted?.id;
  const checkoutUrl = buildHotCheckoutUrl({ itemId, orderId, amount: Number(price.price), currency: price.currency || "USDT", requestId: requestId || orderId, sku });
  return res.json({ success: true, checkout_url: checkoutUrl, order_id: orderId, price: price.price, currency: price.currency || "USDT" });
}));

app.post("/api/soul-chat", express.json(), asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const body = req.body || {};
  const requestId = String(body.request_id || "").trim();
  const question = String(body.question || "").trim();
  const adminToken = String(body.admin_token || "").trim();
  const isAdminCaller = !!ADMIN_SECRET && adminToken === ADMIN_SECRET;
  let telegramUserId = null;
  if (isAdminCaller && body.telegram_user_id != null) {
    telegramUserId = Number(body.telegram_user_id);
  } else {
    const initData = req.headers["x-telegram-init"] || body.initData || "";
    telegramUserId = validateInitData(initData, BOT_TOKEN);
    if (telegramUserId == null) {
      return res.status(401).json({ success: false, error: "Нужна авторизация Telegram." });
    }
  }
  const access = await getSoulChatAccess(telegramUserId);
  if (!access.allowed) {
    return res.status(403).json({
      success: false,
      error: access.reason,
      trial_available: !!access.trial_available,
      need_payment: !access.trial_available,
    });
  }
  const result = await runSoulChat({ requestId, question, telegramUserId, isAdminCaller });
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });

  // Сохраняем диалог в историю (не блокируем ответ на ошибку записи)
  if (supabase) {
    supabase.from("soul_chat_sessions").insert({
      telegram_user_id: Number(telegramUserId),
      track_request_id: result.request?.id || null,
      question,
      answer: result.answer,
    }).then(() => {}).catch((e) => console.warn("[soul-chat] save session:", e?.message));
  }

  return res.json({
    success: true,
    data: {
      request_id: result.request.id,
      name: result.request.name,
      answer: result.answer,
      expires_at: access.expires_at || null,
      source: access.source || null,
    },
  });
}));

app.get("/api/pricing/catalog", asyncApi(async (req, res) => {
  const initData = req.headers["x-telegram-init"] || req.query?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  const catalog = await getPricingCatalog();
  let trialAvailable = true;
  let hasSubscription = false;
  if (telegramUserId != null) {
    trialAvailable = await isTrialAvailable(telegramUserId, "first_song_gift");
    hasSubscription = await hasActiveSubscription(telegramUserId);
  }
  return res.json({
    success: true,
    catalog,
    free_trial: {
      key: "first_song_gift",
      available: trialAvailable,
      description: "Первый звуковой ключ в подарок",
    },
    subscription_active: hasSubscription,
    display_currency: "USDT",
    alt_currencies: ["TON", "USD", "RUB"],
  });
}));

app.post("/api/promos/validate", express.json(), asyncApi(async (req, res) => {
  const initData = req.headers["x-telegram-init"] || req.body?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });
  const sku = String(req.body?.sku || "").trim();
  const code = normalizePromoCode(req.body?.promo_code);
  if (!sku) return res.status(400).json({ success: false, error: "sku обязателен" });
  if (!code) return res.status(400).json({ success: false, error: "promo_code обязателен" });
  const price = await getSkuPrice(sku);
  if (!price) return res.status(404).json({ success: false, error: "SKU не найден" });
  const checked = await validatePromoForOrder({ promoCode: code, sku, telegramUserId });
  if (!checked.ok) {
    const reasonText = {
      not_found: "Промокод не найден",
      inactive: "Промокод неактивен",
      expired: "Срок действия промокода истёк",
      not_started: "Промокод ещё не активен",
      sku_mismatch: "Промокод не подходит для этого продукта",
      global_limit_reached: "Промокод уже использован максимальное количество раз",
      user_limit_reached: "Вы уже использовали этот промокод",
    }[checked.reason] || "Промокод недействителен";
    return res.status(400).json({ success: false, valid: false, reason: checked.reason, error: reasonText });
  }
  const applied = applyPromoToAmount(Number(price.price), checked.promo);
  return res.json({
    success: true,
    valid: true,
    promo: {
      code: checked.code,
      type: checked.promo.type,
      value: checked.promo.value,
      sku: checked.promo.sku || null,
    },
    amount_before: Number(price.price),
    discount_amount: applied.discountAmount,
    amount_after: applied.finalAmount,
    currency: price.currency || "USDT",
  });
}));

// create: owner-check (заявка принадлежит telegram_user_id), идемпотентность (already_paid + тот же payment_order_id)
app.post("/api/payments/hot/create", express.json(), asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || req.body?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });

  const requestId = String(req.body?.request_id || "").trim();
  console.log("[hot/create] входящий запрос", { requestId: requestId ? requestId.slice(0, 8) + "…" : null, hasBody: !!req.body });
  if (!requestId || !UUID_REGEX.test(requestId)) {
    return res.status(400).json({ success: false, error: "request_id (UUID) обязателен" });
  }
  const { data: requestRow, error: reqErr } = await supabase
    .from("track_requests")
    .select("id,telegram_user_id,mode,payment_status,payment_order_id")
    .eq("id", requestId)
    .maybeSingle();
  if (reqErr || !requestRow) return res.status(404).json({ success: false, error: "Заявка не найдена" });
  if (Number(requestRow.telegram_user_id) !== Number(telegramUserId)) {
    return res.status(403).json({ success: false, error: "Нет доступа к этой заявке" });
  }
  if ((requestRow.payment_status || "").toLowerCase() === "paid") {
    return res.json({ success: true, already_paid: true, payment_status: "paid" });
  }

  const sku = String(req.body?.sku || resolveSkuByMode(requestRow.mode)).trim();
  const price = await getSkuPrice(sku);
  if (!price) return res.status(400).json({ success: false, error: `SKU не найден: ${sku}` });
  const promoCode = normalizePromoCode(req.body?.promo_code);
  let promoResult = null;
  let finalAmount = Number(price.price);
  let discountAmount = 0;
  if (promoCode) {
    promoResult = await validatePromoForOrder({ promoCode, sku, telegramUserId });
    if (!promoResult.ok) {
      return res.status(400).json({ success: false, error: "Промокод недействителен", reason: promoResult.reason });
    }
    const applied = applyPromoToAmount(finalAmount, promoResult.promo);
    finalAmount = applied.finalAmount;
    discountAmount = applied.discountAmount;
  }
  const itemId = String(req.body?.item_id || pickHotItemId(sku)).trim();
  if (!itemId) {
    console.warn("[hot/create] HOT_ITEM_ID не задан для sku:", sku, "- задайте HOT_ITEM_ID_DEFAULT или HOT_ITEM_ID_* в Render");
    return res.status(400).json({ success: false, error: "Оплата HOT не настроена: не задан item_id. Добавьте HOT_ITEM_ID_DEFAULT в переменные окружения Render." });
  }
  const orderId = requestRow.payment_order_id || crypto.randomUUID();
  if (promoResult?.promo?.type === "free_generation" || finalAmount <= 0) {
    await grantPurchaseBySku({ telegramUserId, sku, source: "promo_free" });
    await redeemPromoUsage({
      promo: promoResult?.promo,
      telegramUserId,
      requestId,
      orderId,
      discountAmount: Number(price.price),
    });
    await supabase.from("track_requests").update({
      payment_provider: "promo",
      payment_status: "paid",
      payment_order_id: orderId,
      payment_amount: 0,
      payment_currency: price.currency || "USDT",
      promo_code: promoCode || null,
      promo_discount_amount: Number(price.price),
      promo_type: promoResult?.promo?.type || "free_generation",
      payment_raw: {
        provider: "promo",
        sku,
        promo_code: promoCode,
        promo_type: promoResult?.promo?.type || "free_generation",
        amount_before: Number(price.price),
        amount_after: 0,
      },
      paid_at: new Date().toISOString(),
      generation_status: "pending",
      updated_at: new Date().toISOString(),
    }).eq("id", requestId);
    import("./workerSoundKey.js").then(({ generateSoundKey }) => {
      generateSoundKey(requestId).catch((err) => console.error("[payments/hot/create promo-free] generate:", err?.message || err));
    }).catch((err) => console.error("[payments/hot/create promo-free] import worker:", err?.message || err));
    return res.json({
      success: true,
      provider: "promo",
      free_applied: true,
      request_id: requestId,
      order_id: orderId,
      sku,
      promo_code: promoCode || null,
      amount: 0,
      currency: price.currency || "USDT",
      message: "Промокод применён: генерация запущена бесплатно.",
    });
  }
  const checkoutUrl = buildHotCheckoutUrl({
    itemId,
    orderId,
    amount: finalAmount,
    currency: price.currency || "USDT",
    requestId,
    sku,
  });
  console.log("[hot/create] checkout_url сформирован", { requestId: requestId.slice(0, 8), itemId: itemId.slice(0, 12) + "…", urlPrefix: checkoutUrl.slice(0, 60) + "…" });

  const paymentRaw = {
    provider: "hot",
    sku,
    promo_code: promoCode || null,
    amount_before: Number(price.price),
    amount_after: Number(finalAmount),
    discount_amount: Number(discountAmount || 0),
    item_id: itemId || null,
    checkout_url: checkoutUrl,
    created_via: HOT_API_JWT ? "jwt_enabled" : "checkout_link",
  };
  const { error: updateErr } = await supabase.from("track_requests").update({
    payment_provider: "hot",
    payment_status: "pending",
    payment_order_id: orderId,
    payment_amount: Number(finalAmount),
    payment_currency: price.currency || "USDT",
    promo_code: promoCode || null,
    promo_discount_amount: Number(discountAmount || 0),
    promo_type: promoResult?.promo?.type || null,
    payment_raw: paymentRaw,
    updated_at: new Date().toISOString(),
  }).eq("id", requestId);
  if (updateErr && !/does not exist|column/i.test(updateErr.message)) {
    return res.status(500).json({ success: false, error: updateErr.message });
  }

  console.log("[hot/create] успех, возвращаем checkout_url");
  return res.json({
    success: true,
    provider: "hot",
    request_id: requestId,
    order_id: orderId,
    sku,
    amount: Number(finalAmount),
    amount_before: Number(price.price),
    discount_amount: Number(discountAmount || 0),
    currency: price.currency || "USDT",
    promo_code: promoCode || null,
    checkout_url: checkoutUrl,
  });
}));

// Возвращает последнюю pending_payment заявку пользователя (для восстановления на старте)
app.get("/api/my/pending-request", asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false });
  const initData = req.headers["x-telegram-init"] || req.query?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (!telegramUserId) return res.status(401).json({ ok: false });
  const { data } = await supabase
    .from("track_requests")
    .select("id,mode,created_at,generation_status,payment_status")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("generation_status", "pending_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return res.json({ ok: true, pending: false });
  return res.json({ ok: true, pending: true, request_id: data.id, mode: data.mode, created_at: data.created_at });
}));

// Активирует бесплатный пробный ключ для pending_payment заявки (восстановление)
app.post("/api/free-trial/claim", express.json(), asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || req.body?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (!telegramUserId) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const requestId = String(req.body?.request_id || "").trim();
  if (!requestId || !UUID_REGEX.test(requestId)) {
    return res.status(400).json({ ok: false, error: "request_id обязателен" });
  }

  const { data: request } = await supabase
    .from("track_requests")
    .select("id,telegram_user_id,generation_status,payment_status,mode")
    .eq("id", requestId)
    .maybeSingle();

  if (!request) return res.status(404).json({ ok: false, error: "Заявка не найдена" });
  if (Number(request.telegram_user_id) !== Number(telegramUserId)) {
    return res.status(403).json({ ok: false, error: "Нет доступа к этой заявке" });
  }

  const trialAvailable = await isTrialAvailable(telegramUserId, "first_song_gift");
  if (!trialAvailable) {
    return res.status(400).json({ ok: false, error: "Первый бесплатный ключ уже был использован" });
  }

  const consumed = await consumeTrial(telegramUserId, "first_song_gift");
  if (!consumed.ok && consumed.reason === "already_consumed") {
    return res.status(400).json({ ok: false, error: "Первый бесплатный ключ уже был активирован" });
  }

  await supabase.from("track_requests").update({
    payment_provider: "gift",
    payment_status: "gift_used",
    generation_status: "pending",
    updated_at: new Date().toISOString(),
  }).eq("id", requestId);

  import("./workerSoundKey.js").then(({ generateSoundKey }) => {
    generateSoundKey(requestId).catch((err) => console.error("[free-trial/claim] generate:", err?.message));
  }).catch((err) => console.error("[free-trial/claim] import:", err?.message));

  console.log("[free-trial/claim] Активирован подарочный ключ для пользователя", telegramUserId, "заявка", requestId);
  return res.json({ ok: true, request_id: requestId, message: "Бесплатный ключ активирован! Создание началось." });
}));

// status: owner-check (доступ только к своей заявке), GET идемпотентен
app.get("/api/payments/hot/status", asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || req.query?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });
  const requestId = String(req.query?.request_id || "").trim();
  if (!requestId || !UUID_REGEX.test(requestId)) {
    return res.status(400).json({ success: false, error: "request_id (UUID) обязателен" });
  }
  const { data, error } = await supabase
    .from("track_requests")
    .select("id,telegram_user_id,payment_provider,payment_status,payment_order_id,payment_tx_id,payment_amount,payment_currency,payment_raw,paid_at,generation_status,status")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ success: false, error: "Заявка не найдена" });
  if (Number(data.telegram_user_id) !== Number(telegramUserId)) {
    return res.status(403).json({ success: false, error: "Нет доступа к этой заявке" });
  }
  return res.json({ success: true, data });
}));

app.post("/api/payments/hot/confirm", express.json(), asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || req.body?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });
  const requestId = String(req.body?.request_id || "").trim();
  if (!requestId || !UUID_REGEX.test(requestId)) {
    return res.status(400).json({ success: false, error: "request_id (UUID) обязателен" });
  }
  const { data, error } = await supabase
    .from("track_requests")
    .select("id,telegram_user_id,payment_status,status,generation_status")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ success: false, error: "Заявка не найдена" });
  if (Number(data.telegram_user_id) !== Number(telegramUserId)) {
    return res.status(403).json({ success: false, error: "Нет доступа к этой заявке" });
  }
  const paid = String(data.payment_status || "").toLowerCase() === "paid";
  if (!paid) return res.status(409).json({ success: false, error: "Оплата не подтверждена" });
  const gs = String(data.generation_status || data.status || "pending");
  if (["completed", "processing", "lyrics_generated", "suno_processing", "astro_calculated"].includes(gs)) {
    return res.json({ success: true, started: false, status: gs });
  }
  await supabase.from("track_requests").update({
    status: "pending",
    generation_status: "pending",
    updated_at: new Date().toISOString(),
  }).eq("id", requestId);
  import("./workerSoundKey.js").then(({ generateSoundKey }) => {
    generateSoundKey(requestId).catch((err) => console.error("[payments/hot/confirm] generate:", err?.message || err));
  }).catch((err) => console.error("[payments/hot/confirm] import worker:", err?.message || err));
  return res.json({ success: true, started: true, status: "pending" });
}));

app.get("/api/admin/pricing", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  const catalog = await getPricingCatalog();
  return res.json({ success: true, catalog });
}));

app.put("/api/admin/pricing/:sku", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const sku = String(req.params.sku || "").trim();
  if (!sku) return res.status(400).json({ success: false, error: "sku обязателен" });
  const body = req.body || {};
  const payload = {
    sku,
    title: body.title != null ? String(body.title) : sku,
    description: body.description != null ? String(body.description) : null,
    price: body.price != null ? String(body.price) : "0",
    currency: body.currency != null ? String(body.currency).toUpperCase() : "USDT",
    active: body.active !== false,
    limits_json: typeof body.limits_json === "object" ? body.limits_json : parseJsonSafe(body.limits_json, {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("pricing_catalog").upsert(payload, { onConflict: "sku" });
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true, item: payload });
}));

app.get("/api/admin/payments", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  const { data, error } = await supabase
    .from("track_requests")
    .select("id,name,mode,payment_provider,payment_status,payment_order_id,payment_tx_id,payment_amount,payment_currency,promo_code,promo_discount_amount,promo_type,paid_at,created_at")
    .not("payment_provider", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error && /does not exist|column/i.test(error.message)) return res.json({ success: true, data: [] });
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true, data: data || [] });
}));

app.get("/api/admin/promos", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const { data, error } = await supabase
    .from("promo_codes")
    .select("id,code,type,value,sku,max_uses,used_count,per_user_limit,active,starts_at,expires_at,metadata,created_at,updated_at")
    .order("created_at", { ascending: false });
  if (error && /does not exist|relation/i.test(error.message)) return res.json({ success: true, data: [] });
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true, data: data || [] });
}));

app.delete("/api/admin/promos/:code", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const code = normalizePromoCode(req.params.code);
  if (!code) return res.status(400).json({ success: false, error: "code обязателен" });
  const { error } = await supabase.from("promo_codes").delete().eq("code", code);
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true, deleted: code });
}));

app.put("/api/admin/promos/:code", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const code = normalizePromoCode(req.params.code);
  if (!code) return res.status(400).json({ success: false, error: "code обязателен" });
  const b = req.body || {};
  const type = String(b.type || "discount_percent");
  if (!["discount_percent", "discount_amount", "free_generation"].includes(type)) {
    return res.status(400).json({ success: false, error: "Некорректный type" });
  }
  const payload = {
    code,
    type,
    value: type === "free_generation" ? null : Number(b.value || 0),
    sku: b.sku ? String(b.sku) : null,
    max_uses: b.max_uses != null ? Number(b.max_uses) : null,
    per_user_limit: b.per_user_limit != null ? Number(b.per_user_limit) : 1,
    active: b.active !== false,
    starts_at: b.starts_at || null,
    expires_at: b.expires_at || null,
    metadata: typeof b.metadata === "object" ? b.metadata : parseJsonSafe(b.metadata, {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("promo_codes").upsert(payload, { onConflict: "code" });
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true, item: payload });
}));

app.use("/api", (err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err?.message || "Ошибка сервера" });
});

// Чтобы админка/mini app не получали HTML при 404: любой необработанный /api/* → JSON.
function apiNotFoundJson(req, res, next) {
  if (res.headersSent) return next();
  res.status(404).json({ success: false, error: "Not found", path: req.path });
}

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
    if (supabase && name && birthdate && birthplace) {
      const up = {
        telegram_id: telegramUserId,
        name: name || null,
        birthdate: birthdate || null,
        birthplace: birthplace || null,
        birthtime: birthtime || null,
        birthtime_unknown: !!birthtimeUnknown,
        gender: gender || null,
        language: language || "ru",
        updated_at: new Date().toISOString(),
      };
      try {
        await supabase.from("user_profiles").upsert(up, { onConflict: "telegram_id" });
      } catch (_e) { /* user_profiles — не критично, заявка уже сохранена */ }
    }
  } catch (err) {
    console.error("[submit-request] saveRequest:", err?.message || err);
    return res.status(500).json({ error: "Ошибка сохранения заявки" });
  }
  if (!requestId) {
    return res.status(500).json({ error: "Не удалось сохранить заявку" });
  }
  const requestModeForAccess = isNewFormat && (body.mode === "couple" || body.mode === "transit") ? body.mode : "single";
  const access = await resolveAccessForRequest({ telegramUserId, mode: requestModeForAccess });
  if (!access.allowed) {
    console.log("[submit-request] payment_required", { requestId, sku: access.sku, telegramUserId });
    const skuPrice = await getSkuPrice(access.sku);
    await supabase.from("track_requests").update({
      payment_provider: "hot",
      payment_status: "requires_payment",
      payment_amount: skuPrice ? Number(skuPrice.price) : null,
      payment_currency: skuPrice?.currency || "USDT",
      generation_status: "pending_payment",
      updated_at: new Date().toISOString(),
    }).eq("id", requestId);
    // Отправляем пользователю сообщение с кнопками «Оплатить» / «Отменить»
    sendPendingPaymentBotMessage(telegramUserId, requestId);
    return res.status(402).json({
      ok: false,
      payment_required: true,
      requestId,
      sku: access.sku,
      price: skuPrice || null,
      message: "Для этой заявки нужна оплата. Откройте оплату HOT.",
    });
  }
  if (access.source === "trial") {
    const consumed = await consumeTrial(telegramUserId, "first_song_gift");
    if (!consumed.ok) {
      const skuPrice = await getSkuPrice(access.sku);
      await supabase.from("track_requests").update({
        payment_provider: "hot",
        payment_status: "requires_payment",
        payment_amount: skuPrice ? Number(skuPrice.price) : null,
        payment_currency: skuPrice?.currency || "USDT",
        generation_status: "pending_payment",
        updated_at: new Date().toISOString(),
      }).eq("id", requestId);
      sendPendingPaymentBotMessage(telegramUserId, requestId);
      return res.status(402).json({
        ok: false,
        payment_required: true,
        requestId,
        sku: access.sku,
        price: skuPrice || null,
        message: "Подарочный продукт уже использован. Перейдите к оплате.",
      });
    }
  }
  await supabase.from("track_requests").update({
    payment_provider: access.source === "trial" ? "gift" : (access.source === "subscription" ? "subscription" : "hot"),
    payment_status: access.source === "trial" ? "gift_used" : (access.source === "subscription" ? "subscription_active" : "paid"),
    updated_at: new Date().toISOString(),
  }).eq("id", requestId);
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
  try {
    if (process.env.RENDER_EXTERNAL_URL || process.env.MINI_APP_URL) {
      await bot.api.setChatMenuButton({
        menu_button: { type: "web_app", text: "YupSoul", web_app: { url: MINI_APP_URL } },
      });
      console.log("[Bot] Menu Button обновлён:", MINI_APP_URL);
    }
  } catch (e) {
    console.warn("[Bot] Не удалось обновить Menu Button:", e?.message || e);
  }
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
  app.use("/api", apiNotFoundJson);
  globalThis.__EXPRESS_APP__ = app;
  if (WEBHOOK_URL) {
    startBotWithWebhook();
  } else {
    startBotWithPolling();
  }
} else {
  console.log("[HTTP] Слушаю порт", HEROES_API_PORT);
  app.use("/api", createHeroesRouter(supabase, BOT_TOKEN));
  app.use("/api", apiNotFoundJson);
  app.listen(HEROES_API_PORT, "0.0.0.0", () => {
    console.log("[HTTP] Порт открыт:", HEROES_API_PORT);
    if (WEBHOOK_URL) {
      startBotWithWebhook();
    } else {
      startBotWithPolling();
    }
  });
}
