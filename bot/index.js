/**
 * YupSoul Telegram Bot
 * Принимает заявки из Mini App (sendData), сохраняет, отвечает пользователю.
 * HTTP API для «Мои герои» (тариф Мастер).
 */

import { Bot, webhookCallback } from "grammy";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createHeroesRouter, getOrCreateAppUser, validateInitData, parseUserFromInitData } from "./heroesApi.js";
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
// MINI_APP_STABLE_URL — с cache-bust как MINI_APP_URL, чтобы после деплоя пользователи получали свежую версию (раньше без ?v= Telegram кэшировал навсегда)
const MINI_APP_STABLE_URL = MINI_APP_BASE.replace(/\/app\/?$/, "") + "/app?v=" + APP_BUILD;
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
// Реальное username бота — заполняется при старте через bot.api.getMe()
let RESOLVED_BOT_USERNAME = process.env.BOT_USERNAME || "";
const SUPPORT_TG_USERNAME = (process.env.SUPPORT_TG_USERNAME || "yupsoul").trim().replace(/^@/, "");
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
  { sku: "soul_basic_sub", title: "Soul Basic", description: "5 треков/месяц + Soul Chat", price: "14.99", currency: "USDT", active: true, limits_json: { monthly_tracks: 5, monthly_soulchat: 50, kind: "subscription" } },
  { sku: "soul_plus_sub", title: "Soul Plus", description: "10 треков/месяц + Soul Chat без лимита + приоритет", price: "24.99", currency: "USDT", active: true, limits_json: { monthly_tracks: 10, monthly_soulchat: -1, priority: true, kind: "subscription" } },
  { sku: "master_monthly", title: "Лаборатория", description: "30 треков/месяц + Картотека + История генераций", price: "39.99", currency: "USDT", active: true, limits_json: { monthly_tracks: 30, monthly_soulchat: -1, priority: true, lab_access: true, kind: "subscription" } },
];

function resolveSkuByMode(mode) {
  if (mode === "couple") return "couple_song";
  if (mode === "transit") return "transit_energy_song";
  // Подписки: mode = "sub_soul_basic_sub" → sku = "soul_basic_sub"
  if (typeof mode === "string" && mode.startsWith("sub_")) return mode.slice(4);
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

// Промокоды действуют ТОЛЬКО на разовые покупки (песня / чат-день).
// На подписки (soul_basic_sub, soul_plus_sub, master_monthly) промокоды не распространяются.
const SUBSCRIPTION_SKUS = new Set(["soul_basic_sub", "soul_plus_sub", "master_monthly"]);

async function validatePromoForOrder({ promoCode, sku, telegramUserId }) {
  const code = normalizePromoCode(promoCode);
  if (!code) return { ok: false, reason: "empty" };
  // Жёсткий запрет промокодов на подписки
  if (sku && SUBSCRIPTION_SKUS.has(String(sku))) return { ok: false, reason: "sku_mismatch" };
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
  
  // ВАЖНО: Если telegramUserId null/undefined или невалидный — разрешаем trial
  // (новый пользователь, первый визит, проблемы с initData)
  if (!telegramUserId || !Number.isInteger(Number(telegramUserId))) {
    console.log("[Trial] telegramUserId невалидный или отсутствует → разрешаем пробную версию");
    return true;
  }
  
  if (!supabase) {
    console.log("[Trial] Supabase не подключен, разрешаем пробную версию");
    return true;
  }
  
  // КРИТИЧНО: Проверяем ТОЛЬКО таблицу user_trials, а НЕ app_users!
  // Пользователь может быть создан в app_users через Heroes API до первой заявки,
  // но это НЕ означает, что он использовал бесплатную песню.
  // Единственный источник правды — наличие записи в user_trials.
  const { data: trialData, error: trialError } = await supabase
    .from("user_trials")
    .select("id, consumed_at")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("trial_key", trialKey)
    .maybeSingle();
  
  if (trialError && !/does not exist|relation/i.test(trialError.message)) {
    console.error("[Trial] Ошибка запроса к user_trials:", trialError.message);
    // При любой ошибке БД разрешаем пробную версию —
    // consumeTrial защитит от повторного использования через duplicate key
    console.log("[Trial] Ошибка БД user_trials → разрешаем пробную версию (consumeTrial проверит дубль)");
    return true;
  }
  
  const available = !trialData;
  console.log("[Trial] Результат проверки:", available ? "доступна" : "уже использована", "данные:", trialData);
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

// ============================================================================
// РЕФЕРАЛЬНАЯ СИСТЕМА
// ============================================================================

function generateReferralCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function getOrCreateReferralCode(telegramUserId) {
  if (!supabase) return null;
  const { data } = await supabase.from('user_profiles')
    .select('referral_code').eq('telegram_id', Number(telegramUserId)).maybeSingle();
  if (data?.referral_code) return data.referral_code;
  const code = generateReferralCode();
  const { error } = await supabase.from('user_profiles')
    .upsert({ telegram_id: Number(telegramUserId), referral_code: code },
             { onConflict: 'telegram_id' });
  if (error) {
    console.error('[Referral] Ошибка сохранения кода:', error.message);
    return null;
  }
  return code;
}

async function consumeReferralCreditIfAvailable(telegramUserId) {
  if (!supabase) return { ok: false };
  const { data } = await supabase.from('user_profiles')
    .select('referral_credits').eq('telegram_id', Number(telegramUserId)).maybeSingle();
  if (!data?.referral_credits || data.referral_credits < 1) return { ok: false };
  const { data: updated } = await supabase.from('user_profiles')
    .update({ referral_credits: data.referral_credits - 1 })
    .eq('telegram_id', Number(telegramUserId))
    .eq('referral_credits', data.referral_credits)
    .select('referral_credits');
  return updated?.length ? { ok: true } : { ok: false };
}

// ============================================================================

async function hasActiveSubscription(telegramUserId, skus = ["soul_basic_sub", "soul_plus_sub", "master_monthly"]) {
  if (!supabase) return false;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("id,plan_sku,status,renew_at")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("status", "active")
    .gte("renew_at", nowIso)
    .in("plan_sku", skus)
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

  const referralCredit = await consumeReferralCreditIfAvailable(telegramUserId);
  console.log("[Access] Проверка реферального кредита:", referralCredit.ok ? "кредит списан" : "нет кредитов");
  if (referralCredit.ok) return { allowed: true, source: "referral_credit", sku };

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
    (MINI_APP_STABLE_URL + "&payment=success&request_id=" + encodeURIComponent(requestId || ""));
  if (redirectUrl) url.searchParams.set("redirect_url", redirectUrl);
  // notify_url: HOT шлёт webhook сюда при изменении статуса платежа.
  // Без этого параметра — webhook нужно настраивать вручную в кабинете HOT.
  const notifyUrl = process.env.HOT_NOTIFY_URL ||
    (MINI_APP_BASE.replace(/\/app\/?$/, "") + "/api/payments/hot/webhook");
  url.searchParams.set("notify_url", notifyUrl);
  return url.toString();
}

function verifyHotWebhookSignature(rawBody, signatureHeader) {
  if (!HOT_WEBHOOK_SECRET) {
    // Без секрета — пропускаем (небезопасно, но не блокируем работу)
    return true;
  }
  if (!rawBody) {
    console.warn("[webhook] verifyHotWebhookSignature: пустой rawBody");
    return false;
  }
  if (!signatureHeader) {
    // HOT Pay может не присылать подпись — логируем, но пропускаем
    console.warn("[webhook] verifyHotWebhookSignature: заголовок подписи отсутствует — пропускаем проверку");
    return true;
  }
  const expected = crypto.createHmac("sha256", HOT_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const providedRaw = String(signatureHeader).trim();
  // Поддерживаем форматы: "sha256=abc123", "abc123"
  const provided = providedRaw.includes("=") ? providedRaw.split("=").slice(1).join("=") : providedRaw;
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    console.warn(`[webhook] Signature length mismatch: expected=${expected.length} got=${provided.length}`);
    return false;
  }
  const ok = crypto.timingSafeEqual(expectedBuf, providedBuf);
  if (!ok) console.warn("[webhook] Signature mismatch — проверь HOT_WEBHOOK_SECRET в Render");
  return ok;
}

async function createOrRefreshSubscription({ telegramUserId, planSku, source = "hot" }) {
  if (!supabase) return { ok: false, error: "Supabase недоступен" };
  // Проверяем: нет ли уже активной подписки на этот план (идемпотентность)
  const existing = await getActiveSubscriptionFull(telegramUserId);
  if (existing && existing.plan_sku === planSku) {
    console.log(`[sub] Подписка ${planSku} для ${telegramUserId} уже активна (renew_at: ${existing.renew_at})`);
    return { ok: true, renew_at: existing.renew_at, already_active: true };
  }
  const now = new Date();
  const renewAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  // Деактивируем все прежние подписки этого пользователя на любой план
  await supabase.from("subscriptions")
    .update({ status: "cancelled", updated_at: now.toISOString() })
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("status", "active");
  const payload = {
    telegram_user_id: Number(telegramUserId),
    plan_sku: planSku,
    status: "active",
    renew_at: renewAt,
    source,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const { error } = await supabase.from("subscriptions").insert(payload);
  if (error && /does not exist|relation/i.test(error.message)) return { ok: false, error: "missing_table" };
  if (error) {
    console.error(`[sub] Ошибка создания подписки ${planSku} для ${telegramUserId}:`, error.message);
    return { ok: false, error: error.message };
  }
  console.log(`[sub] Подписка ${planSku} создана для ${telegramUserId}, renew_at: ${renewAt}`);
  return { ok: true, renew_at: renewAt };
}

async function hasMasterAccess(telegramUserId) {
  if (!supabase) return false;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("id")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("plan_sku", "master_monthly")
    .eq("status", "active")
    .gte("renew_at", nowIso)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

// Карта SKU → название плана и лимиты треков
const PLAN_META = {
  soul_basic_sub:  { name: "Basic",       tracks: 5,  soulchat: 50 },
  soul_plus_sub:   { name: "Plus",        tracks: 10, soulchat: -1 },
  master_monthly:  { name: "Лаборатория", tracks: 30, soulchat: -1 },
};

async function getActiveSubscriptionFull(telegramUserId) {
  if (!supabase) return null;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("id,plan_sku,status,renew_at,created_at")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("status", "active")
    .gte("renew_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && /does not exist|relation/i.test(error.message)) return null;
  if (error || !data) return null;
  return data;
}

async function countTracksUsedThisMonth(telegramUserId) {
  if (!supabase) return 0;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { count, error } = await supabase
    .from("track_requests")
    .select("id", { count: "exact", head: true })
    .eq("telegram_user_id", Number(telegramUserId))
    .gte("created_at", monthStart)
    .not("generation_status", "in", '("failed","cancelled","rejected")');
  if (error && /does not exist|column/i.test(error.message)) return 0;
  if (error) return 0;
  return Number(count || 0);
}

async function grantPurchaseBySku({ telegramUserId, sku, source = "hot_payment", orderId = null }) {
  const normalizedSku = String(sku || "").trim();
  if (!normalizedSku) return { ok: false, error: "sku_required" };
  if (normalizedSku === "soul_basic_sub" || normalizedSku === "soul_plus_sub" || normalizedSku === "master_monthly") {
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

  // 1. Активная подписка Soul Basic / Soul Plus / Лаборатория (все дают Soul Chat)
  const hasSub = await hasActiveSubscription(telegramUserId);
  if (hasSub) {
    const isMaster = await hasActiveSubscription(telegramUserId, ["master_monthly"]);
    return { allowed: true, source: "subscription", is_master: isMaster, expires_at: null };
  }

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
    .select("id,telegram_user_id,name,gender,birthdate,birthplace,birthtime,birthtime_unknown,mode,person2_name,person2_gender,person2_birthdate,person2_birthplace,transit_date,transit_time,transit_location,transit_intent")
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

function buildSoulChatPrompt(row, astro, question, history = []) {
  const astroText = astro?.snapshot_text || "Нет астро-данных.";
  const astroJson = astro?.snapshot_json && typeof astro.snapshot_json === "object"
    ? JSON.stringify(astro.snapshot_json).slice(0, 12000)
    : "";
  const historyBlock = history.length > 0
    ? "\nИстория диалога (последние сообщения, от старых к новым):\n" +
      history.map((m) => `Пользователь: ${m.question}\nДуша: ${m.answer}`).join("\n\n") + "\n"
    : "";
  return [
    `Ты — голос души ${row.name || "человека"}.`,
    "Ты знаешь натальную карту, даши и транзиты этого человека.",
    "Каждый твой ответ уникален для этой карты — никаких общих советов и мотивационных клише.",
    "Без астрологических терминов. Без морализаторства. Без упоминания песен, заказов или контента.",
    "",
    `Профиль: ${row.name || "—"} (${row.gender || "—"}), ${row.birthdate || "—"}, ${row.birthplace || "—"}.`,
    row.person2_name ? `Партнёр: ${row.person2_name} (${row.person2_gender || "—"}), ${row.person2_birthdate || "—"}, ${row.person2_birthplace || "—"}.` : "",
    row.transit_date || row.transit_location ? `Транзит: ${row.transit_date || "—"} ${row.transit_time || ""}, ${row.transit_location || "—"}.` : "",
    "",
    "Астро-снимок (текст):",
    astroText,
    astroJson ? `\nАстро-снимок (json): ${astroJson}` : "",
    historyBlock,
    `Вопрос: "${question}"`,
  ].filter(Boolean).join("\n");
}

function buildSoulChatPromptFromProfile(profile, question, history = []) {
  const historyBlock = history.length > 0
    ? "\nИстория диалога (последние сообщения, от старых к новым):\n" +
      history.map((m) => `Пользователь: ${m.question}\nДуша: ${m.answer}`).join("\n\n") + "\n"
    : "";
  return [
    `Ты — голос души ${profile.name || "человека"}.`,
    "Каждый ответ — уникально для этого человека. Никаких общих советов и клише.",
    "Без астрологических терминов. Без морализаторства.",
    "",
    `Профиль: ${profile.name || "—"} (${profile.gender || "—"}), дата рождения: ${profile.birthdate || "—"}.`,
    historyBlock,
    `Вопрос: "${question}"`,
  ].filter(Boolean).join("\n");
}

function buildSynastryPrompt(row1, astro1, row2, astro2, question, history = []) {
  const historyBlock = history.length > 0
    ? "\nИстория диалога (последние сообщения, от старых к новым):\n" +
      history.map((m) => `Пользователь: ${m.question}\nДуша: ${m.answer}`).join("\n\n") + "\n"
    : "";
  return `Ты — астрологический аналитик синастрии двух людей.
Анализируй совместимость, динамику и точки пересечения их карт.
Каждый ответ — конкретно по этим двум картам. Никаких общих советов.
Отвечай тепло, без астрологических терминов.

Карта 1: ${row1.name || "—"}, ${row1.gender || "—"}, ${row1.birthdate || "—"}, ${row1.birthplace || "—"}
Астро 1: ${astro1?.snapshot_text?.slice(0, 6000) || "нет данных"}

Карта 2: ${row2.name || "—"}, ${row2.gender || "—"}, ${row2.birthdate || "—"}, ${row2.birthplace || "—"}
Астро 2: ${astro2?.snapshot_text?.slice(0, 6000) || "нет данных"}
${historyBlock}
Вопрос: "${question}"`;
}

async function getUserProfileForSoulChat(telegramUserId) {
  if (!supabase || !telegramUserId) return null;
  const { data } = await supabase
    .from("user_profiles")
    .select("name,birthdate,gender")
    .eq("telegram_id", Number(telegramUserId))
    .maybeSingle();
  return data || null;
}

// Загружает последние N сообщений диалога для контекста Soul Chat
async function loadSoulChatHistory(telegramUserId, trackRequestId, limit = 6) {
  if (!supabase || !telegramUserId || !trackRequestId) return [];
  const { data } = await supabase
    .from("soul_chat_sessions")
    .select("question,answer")
    .eq("telegram_user_id", Number(telegramUserId))
    .eq("track_request_id", trackRequestId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []).reverse(); // хронологический порядок
}

const SOUL_CHAT_SYSTEM =
  "Ты — этичный внутренний друг, голос души. " +
  "Отвечай 3-5 предложениями — точно и лично, только из данных ниже. " +
  "Запрещены общие фразы: «всё будет хорошо», «ты справишься», «верь в себя». " +
  "Будь честным даже если правда неудобна — но всегда с теплом и без осуждения. " +
  "Не раздувай страхи и не сгущай краски — говори о потенциале, не о судьбе. " +
  "Если тема касается здоровья, острой тревоги или кризиса — мягко порекомендуй поговорить с живым человеком (специалистом или близким). " +
  "Без астрологических терминов. " +
  "Если вопрос продолжает предыдущий разговор — отвечай с учётом истории.";

async function runSoulChat({ requestId, requestId2, question, telegramUserId, isAdminCaller = false }) {
  let rid = String(requestId || "").trim();
  const rid2 = String(requestId2 || "").trim();
  const q = String(question || "").trim();
  if (!q) return { ok: false, error: "Пустой вопрос" };
  // Если request_id не передан или невалиден — ищем последнюю заявку пользователя
  if (!rid || !UUID_REGEX.test(rid)) {
    rid = (telegramUserId ? await getLastCompletedRequestForUser(telegramUserId) : null) || "";
  }

  const SC_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-reasoner";
  const SC_OPTS = { model: SC_MODEL, max_tokens: 1800, temperature: 1.1 };

  // Есть заявка — используем её данные
  if (rid && UUID_REGEX.test(rid)) {
    const loaded = await getRequestForSoulChat(rid);
    if (loaded.error) return { ok: false, error: loaded.error };
    const { row, astro } = loaded;
    if (!isAdminCaller && Number(row.telegram_user_id) !== Number(telegramUserId)) {
      return { ok: false, error: "Нет доступа к этой заявке" };
    }

    // Загружаем историю диалога для контекста
    const history = await loadSoulChatHistory(telegramUserId, row.id);

    // Синастрия: вторая карточка
    if (rid2 && UUID_REGEX.test(rid2)) {
      const loaded2 = await getRequestForSoulChat(rid2);
      if (!loaded2.error) {
        const synPrompt = buildSynastryPrompt(row, astro, loaded2.row, loaded2.astro, q, history);
        const llm2 = await chatCompletion(SOUL_CHAT_SYSTEM, synPrompt, SC_OPTS);
        if (!llm2.ok) return { ok: false, error: llm2.error || "Ошибка генерации синастрии" };
        return { ok: true, answer: String(llm2.text || "").trim(), request: row, source: "synastry" };
      }
    }

    const soulPrompt = buildSoulChatPrompt(row, astro, q, history);
    const llm = await chatCompletion(SOUL_CHAT_SYSTEM, soulPrompt, SC_OPTS);
    if (!llm.ok) return { ok: false, error: llm.error || "Ошибка генерации soul-chat" };
    return { ok: true, answer: String(llm.text || "").trim(), request: row, source: "request" };
  }

  // Нет заявки — пробуем профиль пользователя
  if (telegramUserId) {
    const profile = await getUserProfileForSoulChat(telegramUserId);
    if (profile && profile.name && profile.birthdate) {
      // Для профиля — история без track_request_id (фильтр только по пользователю)
      const profileHistory = supabase ? await (async () => {
        const { data } = await supabase.from("soul_chat_sessions")
          .select("question,answer")
          .eq("telegram_user_id", Number(telegramUserId))
          .is("track_request_id", null)
          .order("created_at", { ascending: false })
          .limit(6);
        return (data || []).reverse();
      })() : [];
      const soulPrompt = buildSoulChatPromptFromProfile(profile, q, profileHistory);
      const llm = await chatCompletion(SOUL_CHAT_SYSTEM, soulPrompt, SC_OPTS);
      if (!llm.ok) return { ok: false, error: llm.error || "Ошибка генерации soul-chat" };
      return { ok: true, answer: String(llm.text || "").trim(), request: { name: profile.name }, source: "profile" };
    }
  }

  return { ok: false, error: "Заполни профиль (имя и дата рождения), чтобы начать чат." };
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
    const { data: client, error: clientErr } = await supabase.from("clients").select("name, birth_date, birth_time, birth_place, birthtime_unknown, gender, preferred_style, notes, relationship").eq("id", data.client_id).maybeSingle();
    if (!clientErr && client) {
      row = { ...row, client_id: data.client_id, name: client.name ?? row.name, birthdate: client.birth_date ?? row.birthdate, birthtime: client.birth_time ?? row.birthtime, birthplace: client.birth_place ?? row.birthplace, birthtime_unknown: !!client.birthtime_unknown, gender: client.gender ?? row.gender };
      // Добавляем relationship, preferred_style и notes героя в текст запроса, чтобы они попали в промпт LLM
      const extras = [];
      if (client.relationship) extras.push(`Социальная роль / отношение к заказчику: ${client.relationship}`);
      if (client.preferred_style) extras.push(`Предпочтительный музыкальный стиль: ${client.preferred_style}`);
      if (client.notes) extras.push(`Заметки о человеке: ${client.notes}`);
      if (extras.length) {
        row.request = [row.request || 'создать песню', ...extras].join('\n');
      }
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
  const payUrl = MINI_APP_STABLE_URL + "&requestId=" + encodeURIComponent(requestId);
  const shortId = String(requestId || "").substring(0, 8);
  const trialAvailable = supabase ? await isTrialAvailable(telegramUserId, "first_song_gift") : false;
  const firstSongHint = trialAvailable
    ? "\n\n🎁 _Если это твоя первая песня — открой приложение по кнопке ниже и на главном экране нажми «Получить бесплатно»._"
    : "";
  try {
    await bot.api.sendMessage(
      telegramUserId,
      `⏳ *Заявка создана, но ожидает оплаты*\n\nID: \`${shortId}\`\n\nВыбери действие:${firstSongHint}`,
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
  // --- Обработка реферального deep link ---
  const payload = ctx.match; // "ref_A3K9PX" или пусто
  const telegramUserId = ctx.from?.id;
  if (supabase && payload?.startsWith('ref_') && telegramUserId) {
    const refCode = payload.slice(4);
    try {
      const { data: referrer } = await supabase.from('user_profiles')
        .select('telegram_id').eq('referral_code', refCode).maybeSingle();
      if (referrer && Number(referrer.telegram_id) !== Number(telegramUserId)) {
        const { data: existing } = await supabase.from('user_profiles')
          .select('referred_by').eq('telegram_id', Number(telegramUserId)).maybeSingle();
        if (!existing?.referred_by) {
          await supabase.from('user_profiles')
            .upsert({ telegram_id: Number(telegramUserId), referred_by: refCode },
                     { onConflict: 'telegram_id' });
          await supabase.from('referrals').insert({
            referrer_id: Number(referrer.telegram_id),
            referee_id: Number(telegramUserId),
          }).select().maybeSingle();
          console.log(`[Referral] Новый реферал: referrer=${referrer.telegram_id}, referee=${telegramUserId}, code=${refCode}`);
        }
      }
    } catch (e) {
      console.warn('[Referral] Ошибка обработки ref_ payload:', e?.message);
    }
  }
  // -----------------------------------------

  // Фиксируем факт старта бота — создаём/обновляем запись в user_profiles (включая username для ссылок в админке)
  if (supabase && telegramUserId) {
    const profileData = { telegram_id: Number(telegramUserId), updated_at: new Date().toISOString() };
    if (ctx.from?.username) profileData.tg_username = ctx.from.username;
    supabase.from("user_profiles").upsert(profileData, { onConflict: "telegram_id" })
      .then(() => null).catch((e) => console.warn("[start] upsert user_profiles:", e?.message));
  }

  const name = ctx.from?.first_name || "друг";
  const isReturning = payload === "song_ready" || payload === "miniapp_start";
  const PLAN_PAYLOAD_MAP = { plan_basic: "soul_basic_sub", plan_plus: "soul_plus_sub", plan_master: "master_monthly" };
  const isPlanInquiry = Object.prototype.hasOwnProperty.call(PLAN_PAYLOAD_MAP, payload || "");

  // Обновляем Menu Button при каждом /start
  try {
    await bot.api.setChatMenuButton({
      chat_id: ctx.chat?.id,
      menu_button: { type: "web_app", text: "🎵 YupSoul", web_app: { url: MINI_APP_URL } },
    });
  } catch (menuErr) {
    console.warn("[start] Не удалось обновить Menu Button:", menuErr?.message);
  }

  // --- Автоматическое оформление подписки ---
  if (isPlanInquiry && telegramUserId) {
    const planSku = PLAN_PAYLOAD_MAP[payload];
    const planInfo = PLAN_META[planSku] || { name: planSku, tracks: 0 };

    try {
      // Проверяем, не активна ли уже такая подписка
      const existingSub = await getActiveSubscriptionFull(telegramUserId);
      if (existingSub) {
        const existingPlanInfo = PLAN_META[existingSub.plan_sku] || { name: existingSub.plan_sku };
        const renewDate = new Date(existingSub.renew_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
        if (existingSub.plan_sku === planSku) {
          await ctx.reply(
            `${name}, у тебя уже активна подписка *${existingPlanInfo.name}*.\n\nОна действует до ${renewDate}.\n\nОткрой YupSoul и создавай песни ↓`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🎵 Открыть YupSoul", web_app: { url: MINI_APP_STABLE_URL } }]] } }
          );
          return;
        }
      }

      // Пробуем создать HOT Pay checkout
      const priceData = await getSkuPrice(planSku);
      const itemId = pickHotItemId(planSku);

      if (itemId && priceData) {
        const orderId = crypto.randomUUID();
        const requestId = crypto.randomUUID();

        if (supabase) {
          await supabase.from("track_requests").insert({
            id: requestId,
            telegram_user_id: Number(telegramUserId),
            name: name,
            mode: `sub_${planSku}`,
            payment_status: "pending",
            payment_provider: "hot",
            payment_order_id: orderId,
            payment_amount: Number(priceData.price),
            payment_currency: priceData.currency || "USDT",
            payment_raw: JSON.stringify({ provider: "hot", sku: planSku, plan: payload, amount_before: Number(priceData.price) }),
            generation_status: "pending_payment",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).select().maybeSingle();
        }

        const checkoutUrl = buildHotCheckoutUrl({
          itemId,
          orderId,
          amount: Number(priceData.price),
          currency: priceData.currency || "USDT",
          requestId,
          sku: planSku,
        });

        console.log(`[start] Сформирована ссылка подписки: sku=${planSku}, orderId=${orderId.slice(0, 8)}`);
        await ctx.reply(
          `${name}, оформляем *${planInfo.name}* — ${planInfo.tracks} треков в месяц.\n\n💳 Стоимость: *${priceData.price} USDT/мес*\n\nНажми кнопку ниже для оплаты. После оплаты я пришлю подтверждение и подписка активируется автоматически.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: `💳 Оплатить — ${priceData.price} USDT`, url: checkoutUrl }],
                [{ text: "🎵 Открыть YupSoul", web_app: { url: MINI_APP_STABLE_URL } }],
              ],
            },
          }
        );
      } else {
        // HOT Pay item_id не настроен — дружелюбный фолбэк
        console.warn(`[start] HOT_ITEM_ID не настроен для sku=${planSku}`);
        await ctx.reply(
          `${name}, отлично — ты хочешь оформить *${planInfo.name}* (${planInfo.tracks} треков/мес).\n\n✉️ Напиши нам, и мы вышлем ссылку на оплату в течение нескольких минут.`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🎵 Открыть YupSoul", web_app: { url: MINI_APP_STABLE_URL } }]] },
          }
        );
      }
    } catch (planErr) {
      console.error("[start] Ошибка при обработке plan inquiry:", planErr?.message || planErr);
      await ctx.reply(`${name}, произошла ошибка. Попробуй ещё раз или напиши нам.`).catch(() => {});
    }
    return;
  }

  // --- Обычный /start ---
  const startText = isReturning
    ? bMsg(ctx, 'startReturning', name)
    : bMsg(ctx, 'startNew', name);

  const startKeyboard = isReturning
    ? {
        inline_keyboard: [
          [{ text: bMsg(ctx, 'btnOpenApp'), web_app: { url: MINI_APP_STABLE_URL } }],
          [{ text: "🔔 Песня не пришла?", callback_data: "song_not_arrived" }],
        ],
      }
    : { inline_keyboard: [[{ text: bMsg(ctx, 'btnOpenApp'), web_app: { url: MINI_APP_STABLE_URL } }]] };

  try {
    await ctx.reply(startText, {
      parse_mode: "Markdown",
      reply_markup: startKeyboard,
    });
  } catch (e) {
    console.error("[start] Ошибка ответа:", e?.message || e);
    try {
      await ctx.reply(bMsg(ctx, 'startNew', name));
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
    await ctx.reply(bMsg(ctx, 'requestError'));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
    console.log("[Заявка] JSON распарсен, поля:", Object.keys(payload));
  } catch (e) {
    console.error("[Заявка] Ошибка парсинга JSON:", e.message, "Сырые данные (первые 200 символов):", raw?.slice(0, 200));
    await ctx.reply(bMsg(ctx, 'requestError'));
    return;
  }
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    console.error("[Заявка] Нет ctx.from.id, ctx.from:", ctx.from);
    await ctx.reply(bMsg(ctx, 'requestError'));
    return;
  }

  // Сохраняем username при каждой заявке — для ссылок в админке
  if (supabase && ctx.from?.username) {
    supabase.from("user_profiles").upsert(
      { telegram_id: Number(telegramUserId), tg_username: ctx.from.username, updated_at: new Date().toISOString() },
      { onConflict: "telegram_id" }
    ).catch((e) => console.warn("[Заявка] upsert tg_username:", e?.message));
  }

  console.log("[Заявка] Пользователь:", telegramUserId, "Имя:", payload.name, "Место:", payload.birthplace, "Координаты:", payload.birthplaceLat ? `${payload.birthplaceLat}, ${payload.birthplaceLon}` : "нет");
  await ctx.reply(bMsg(ctx, 'requestReceived'));

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
    await ctx.reply(bMsg(ctx, 'requestError'));
    return;
  }

  if (!requestId) {
    await ctx.reply(bMsg(ctx, 'requestError'));
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

  await ctx.reply(bMsg(ctx, 'requestSaved', name || ctx.from?.first_name || ''));

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
    await ctx.reply(bMsg(ctx, 'requestError')).catch(() => {});
  }
});

// Убирает markdown-символы из текста LLM перед отправкой в Telegram без parse_mode
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')          // # ## ### заголовки
    .replace(/\*\*\*(.+?)\*\*\*/gs, '$1') // ***жирный курсив***
    .replace(/\*\*(.+?)\*\*/gs, '$1')     // **жирный**
    .replace(/\*(.+?)\*/gs, '$1')         // *курсив*
    .replace(/__(.+?)__/gs, '$1')         // __жирный__
    .replace(/_(.+?)_/gs, '$1')           // _курсив_
    .replace(/~~(.+?)~~/gs, '$1')         // ~~зачёркнутый~~
    .replace(/`{3}[\s\S]*?`{3}/g, '')     // ```блок кода```
    .replace(/`(.+?)`/g, '$1')            // `инлайн код`
    .replace(/^>\s+/gm, '')               // > цитата
    .replace(/^[-*+]\s+/gm, '• ')         // - * + списки → •
    .replace(/^\d+\.\s+/gm, '')           // 1. нумерованные списки
    .replace(/^---+$/gm, '')              // горизонтальные линии
    .replace(/\[(.+?)\]\(.*?\)/g, '$1')   // [ссылка](url) → текст
    .replace(/\n{3,}/g, '\n\n')           // тройные переносы → двойные
    .trim();
}

// Убирает технические блоки Suno/LLM из текста анализа перед отправкой пользователю
function cleanAnalysisForUser(text) {
  if (!text) return "";
  const lines = text.split("\n");
  const cleaned = [];
  let skipBlock = false;
  for (const line of lines) {
    // Начало технического блока — пропускаем всё до конца
    if (/^\s*(MUSIC PROMPT|SUNO PROMPT|STRICT TECHNICAL|ТЕХНИЧЕСКИЕ|ЭТАП\s*3|ЛИРИКА\s*:|LYRICS?\s*:|Текст песни\s*:|Song lyrics?\s*:|\[style:|ПЕСНЯ ДЛЯ SUNO)/i.test(line)) {
      skipBlock = true;
    }
    // Отдельные технические строки с тегами Suno
    if (/^\s*\[(style|vocal|mood|instruments|tempo|verse|chorus|intro|outro|bridge|pre-chorus|hook)\s*[:=]/i.test(line)) {
      continue;
    }
    if (skipBlock) continue;
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Расшифровка: в чат пользователю отправляется глубокий анализ из результата промта (detailed_analysis = Этап 1 + при необходимости Этап 2). Первая бесплатно, далее — этичное предложение заказать новую песню.
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
      .select("id, detailed_analysis, lyrics, analysis_paid")
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
    await ctx.reply("У тебя пока нет готовой расшифровки. Дождись готовой песни по заявке — тогда можно будет запросить текстовую расшифровку (первый раз бесплатно).");
    return;
  }

  // Проверяем, использовал ли пользователь уже бесплатную расшифровку
  let freeUsed = null;
  try {
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("free_analysis_used_at")
      .eq("telegram_id", telegramUserId)
      .maybeSingle();
    freeUsed = profile?.free_analysis_used_at ?? null;
  } catch (_) {}

  const allowFree = freeUsed == null;
  const allowed = row.analysis_paid || allowFree;

  if (!allowed) {
    const ethicalText =
      "Первую расшифровку ты уже получил(а) бесплатно — спасибо, что был(а) с нами.\n\n" +
      "Если захочешь прочитать расшифровку к следующей песне — закажи новую в приложении: мы пришлём и трек, и текст. Так ты сможешь глубже прожить каждую песню.";
    await ctx.reply(ethicalText, {
      reply_markup: {
        inline_keyboard: [[{ text: "🎵 Открыть приложение", web_app: { url: MINI_APP_STABLE_URL } }]],
      },
    });
    return;
  }

  const TELEGRAM_MAX = 4096;
  // detailed_analysis = глубокий анализ из ответа LLM (только личный разбор, без Suno-технических блоков)
  const text = stripMarkdown(cleanAnalysisForUser(String(row.detailed_analysis || "").trim()));
  if (!text) {
    await ctx.reply("Текст расшифровки пуст. Обратись в поддержку.");
    return;
  }

  // Первый раз бесплатно — отмечаем использование
  if (allowFree) {
    try {
      await supabase.from("user_profiles").upsert(
        { telegram_id: telegramUserId, free_analysis_used_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "telegram_id" }
      );
    } catch (_) {}
    try {
      await supabase.from("track_requests").update({ analysis_paid: true }).eq("id", row.id);
    } catch (_) {}
  }

  if (text.length <= TELEGRAM_MAX) {
    await ctx.reply("📜 Текстовая расшифровка запроса к этой песне:\n\n" + text);
  } else {
    await ctx.reply("📜 Текстовая расшифровка запроса (несколько сообщений):");
    for (let i = 0; i < text.length; i += TELEGRAM_MAX - 50) {
      await ctx.reply(text.slice(i, i + TELEGRAM_MAX - 50));
    }
  }

  // Предложение посмотреть текст песни — только если lyrics есть в БД
  const hasLyrics = !!(row.lyrics && String(row.lyrics).trim().length > 50);
  const lyricsKeyboard = hasLyrics
    ? { reply_markup: { inline_keyboard: [[{ text: "🎵 Текст песни", callback_data: "get_lyrics" }]] } }
    : {};

  // После выдачи бесплатной расшифровки — мягкое предложение
  if (allowFree) {
    await ctx.reply("Если захочешь ещё одну песню и расшифровку к ней — закажи в приложении. Музыка твоей души 💫", {
      reply_markup: {
        inline_keyboard: [
          ...(hasLyrics ? [[{ text: "🎵 Текст песни", callback_data: "get_lyrics" }]] : []),
          [{ text: "🎵 Заказать песню", web_app: { url: MINI_APP_STABLE_URL } }],
        ],
      },
    });
  } else if (hasLyrics) {
    await ctx.reply("Хочешь прочитать слова своей песни?", lyricsKeyboard);
  }
}

bot.command("get_analysis", sendAnalysisIfPaid);
bot.hears(/^(расшифровка|получить расшифровку|детальный анализ)$/i, sendAnalysisIfPaid);

// Кнопка «Получить расшифровку» из inline keyboard
bot.callbackQuery("get_analysis", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await sendAnalysisIfPaid(ctx);
});

// Кнопка «Текст песни» — отправляет только лирику последней завершённой заявки
bot.callbackQuery("get_lyrics", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId || !supabase) {
    await ctx.reply("Не удалось загрузить текст песни. Попробуй позже.");
    return;
  }
  try {
    const { data: row } = await supabase
      .from("track_requests")
      .select("title, lyrics")
      .eq("telegram_user_id", telegramUserId)
      .eq("status", "completed")
      .not("lyrics", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!row?.lyrics || String(row.lyrics).trim().length < 20) {
      await ctx.reply("Текст песни не найден. Возможно, он ещё не сохранился — попробуй позже.");
      return;
    }
    const title = row.title ? `🎵 «${row.title}»\n\n` : "🎵 Текст твоей песни:\n\n";
    const lyricsText = String(row.lyrics).trim();
    const TELEGRAM_MAX = 4096;
    if ((title + lyricsText).length <= TELEGRAM_MAX) {
      await ctx.reply(title + lyricsText);
    } else {
      await ctx.reply(title);
      for (let i = 0; i < lyricsText.length; i += TELEGRAM_MAX - 50) {
        await ctx.reply(lyricsText.slice(i, i + TELEGRAM_MAX - 50));
      }
    }
  } catch (e) {
    console.error("[get_lyrics]", e?.message);
    await ctx.reply("Не удалось загрузить текст песни. Попробуй позже.");
  }
});

// Определяем язык пользователя по Telegram language_code
function getUserLang(ctx) {
  const lc = (ctx.from?.language_code || '').toLowerCase();
  if (/^uk/.test(lc)) return 'uk';
  if (/^en/.test(lc)) return 'en';
  if (/^de/.test(lc)) return 'de';
  if (/^fr/.test(lc)) return 'fr';
  return 'ru';
}

// Мультиязычные сообщения для бота
const BOT_MSGS = {
  ru: {
    startNew: (name) => `${name}, привет.\n\nУ каждого человека есть своя музыка — та, что написана по его дате рождения.\n\nYupSoul создаёт её. Первая песня — в подарок.\n\nНажми кнопку ниже, чтобы начать ↓`,
    startReturning: (name) => `${name}, ты вернулся — хорошо.\n\nПесня уже ждёт тебя здесь, в этом чате. Если ещё не пришла — напиши «песня не пришла».\n\nГотов создать ещё одну?`,
    btnOpenApp: "🎵 Создать свою песню",
    requestReceived: "⏳ Получил заявку, сохраняю…",
    requestSaved: (name) => `✅ Заявка принята, ${name}! Песня генерируется — придёт прямо сюда в чат, когда будет готова.`,
    requestError: "Произошла ошибка. Попробуй ещё раз или напиши в поддержку.",
    songCaption: (name) => `${name}, твоя персональная песня готова. Слушай в тишине — это твоя музыка. ✨`,
    notifyFixed: (name) => `${name}, мы исправили определение языка — теперь твоя песня будет на нужном языке.\n\nЕсли хочешь заказать новую версию — открой приложение и создай заявку заново. Первая после исправления — бесплатно.`,
    noSongInQueue: "Проверил — у тебя нет песен в очереди на повторную отправку.\n\nЕсли песня не пришла:\n• Подожди 15–20 минут — песня может ещё генерироваться\n• Убедись, что не блокировал бота и нажал «Старт»\n• Напиши в поддержку — пришлём вручную",
    pendingHint: "\n\n🎁 У тебя есть заявка, которая ждёт активации подарка. Открой приложение (кнопка в меню чата) и нажми «Получить бесплатно».",
    cooldown: (m) => `Подожди ещё ${m} мин. — повторная попытка ограничена раз в 10 минут.`,
    noUser: "Не удалось определить пользователя. Попробуй снова или напиши в поддержку.",
    resendOk: (title) => `🎵 Пересылаю твою песню «${title}»...`,
    resendErr: "Ошибка при повторной отправке. Напиши в поддержку.",
  },
  uk: {
    startNew: (name) => `${name}, привіт.\n\nУ кожної людини є своя музика — та, що написана за датою народження.\n\nYupSoul створює її. Перша пісня — в подарунок.\n\nНатисни кнопку нижче, щоб почати ↓`,
    startReturning: (name) => `${name}, ти повернувся — добре.\n\nПісня вже чекає тебе тут, у цьому чаті. Якщо ще не прийшла — зачекай кілька хвилин.\n\nГотовий створити ще одну?`,
    btnOpenApp: "🎵 Створити свою пісню",
    requestReceived: "⏳ Отримав заявку, зберігаю…",
    requestSaved: (name) => `✅ Заявку прийнято, ${name}! Пісня буде готова за кілька хвилин — надійде прямо сюди в чат.`,
    requestError: "Сталася помилка. Спробуй ще раз або напиши у підтримку.",
    songCaption: (name) => `${name}, твоя персональна пісня готова. Слухай у тиші — це твоя музика. ✨`,
    notifyFixed: (name) => `${name}, ми виправили визначення мови — тепер твоя пісня буде потрібною мовою.\n\nЯкщо хочеш замовити нову версію — відкрий додаток і створи заявку знову. Перша після виправлення — безкоштовно.`,
    noSongInQueue: "Перевірив — у тебе немає пісень у черзі на повторне надсилання.\n\nЯкщо пісня не прийшла:\n• Зачекай 15–20 хвилин — пісня може ще генеруватися\n• Переконайся, що не блокував бота та натиснув «Старт»\n• Напиши у підтримку — надішлемо вручну",
    pendingHint: "\n\n🎁 У тебе є заявка, яка чекає активації подарунка. Відкрий додаток (кнопка в меню чату) та натисни «Отримати безкоштовно».",
    cooldown: (m) => `Зачекай ще ${m} хв. — повторна спроба обмежена раз на 10 хвилин.`,
    noUser: "Не вдалося визначити користувача. Спробуй ще раз або напиши у підтримку.",
    resendOk: (title) => `🎵 Пересилаю твою пісню «${title}»...`,
    resendErr: "Помилка при повторному надсиланні. Напиши у підтримку.",
  },
  en: {
    startNew: (name) => `${name}, hi.\n\nEvery person has their own music — written from their date of birth.\n\nYupSoul creates it. Your first song is a gift.\n\nTap the button below to start ↓`,
    startReturning: (name) => `${name}, welcome back.\n\nYour song is waiting here in this chat. If it hasn't arrived yet — wait a few minutes.\n\nReady to create another one?`,
    btnOpenApp: "🎵 Create my song",
    requestReceived: "⏳ Got your request, saving…",
    requestSaved: (name) => `✅ Request accepted, ${name}! Your song is being created — it will arrive right here in chat when ready.`,
    requestError: "An error occurred. Please try again or contact support.",
    songCaption: (name) => `${name}, your personal song is ready. Listen in silence — this is your music. ✨`,
    notifyFixed: (name) => `${name}, we fixed language detection — your next song will be in the right language.\n\nIf you'd like a new version — open the app and create a new request. First one after the fix is free.`,
    noSongInQueue: "Checked — you have no songs waiting for resend.\n\nIf your song hasn't arrived:\n• Wait 15–20 minutes — it may still be generating\n• Make sure you haven't blocked the bot and pressed «Start»\n• Contact support — we'll send it manually",
    pendingHint: "\n\n🎁 You have a request waiting for gift activation. Open the app (menu button in chat) and tap «Get for free».",
    cooldown: (m) => `Please wait ${m} more min. — resend is limited to once every 10 minutes.`,
    noUser: "Could not identify user. Try again or contact support.",
    resendOk: (title) => `🎵 Resending your song «${title}»...`,
    resendErr: "Error while resending. Please contact support.",
  },
  de: {
    startNew: (name) => `${name}, hallo.\n\nJeder Mensch hat seine eigene Musik — geschrieben nach seinem Geburtsdatum.\n\nYupSoul erschafft sie. Das erste Lied ist ein Geschenk.\n\nTippe auf den Button unten, um zu beginnen ↓`,
    startReturning: (name) => `${name}, willkommen zurück.\n\nDein Lied wartet bereits hier in diesem Chat. Falls es noch nicht angekommen ist — warte noch ein paar Minuten.\n\nBereit, ein weiteres zu erstellen?`,
    btnOpenApp: "🎵 Mein Lied erstellen",
    requestReceived: "⏳ Anfrage erhalten, speichere…",
    requestSaved: (name) => `✅ Anfrage angenommen, ${name}! Dein Lied wird in wenigen Minuten fertig sein — es kommt direkt hier in den Chat.`,
    requestError: "Ein Fehler ist aufgetreten. Versuche es erneut oder kontaktiere den Support.",
    songCaption: (name) => `${name}, dein persönliches Lied ist fertig. Höre es in Stille — das ist deine Musik. ✨`,
    notifyFixed: (name) => `${name}, wir haben die Spracherkennung verbessert — dein nächstes Lied wird in der richtigen Sprache sein.\n\nWenn du eine neue Version möchtest — öffne die App und erstelle eine neue Anfrage. Die erste nach dem Fix ist kostenlos.`,
    noSongInQueue: "Geprüft — du hast keine Lieder in der Warteschlange zum erneuten Senden.\n\nWenn dein Lied nicht angekommen ist:\n• Warte 15–20 Minuten — es könnte noch generiert werden\n• Stelle sicher, dass du den Bot nicht gesperrt hast und auf «Start» gedrückt hast\n• Kontaktiere den Support — wir senden es manuell",
    pendingHint: "\n\n🎁 Du hast eine Anfrage, die auf die Geschenk-Aktivierung wartet. Öffne die App (Menü-Button im Chat) und tippe auf «Kostenlos erhalten».",
    cooldown: (m) => `Bitte warte noch ${m} Min. — erneutes Senden ist auf einmal alle 10 Minuten begrenzt.`,
    noUser: "Benutzer konnte nicht identifiziert werden. Versuche es erneut oder kontaktiere den Support.",
    resendOk: (title) => `🎵 Sende dein Lied «${title}» erneut...`,
    resendErr: "Fehler beim erneuten Senden. Bitte kontaktiere den Support.",
  },
  fr: {
    startNew: (name) => `${name}, bonjour.\n\nChaque personne a sa propre musique — écrite selon sa date de naissance.\n\nYupSoul la crée. La première chanson est un cadeau.\n\nAppuie sur le bouton ci-dessous pour commencer ↓`,
    startReturning: (name) => `${name}, content de te revoir.\n\nTa chanson t'attend ici dans ce chat. Si elle n'est pas encore arrivée — attends quelques minutes.\n\nPrêt à en créer une autre ?`,
    btnOpenApp: "🎵 Créer ma chanson",
    requestReceived: "⏳ Demande reçue, enregistrement…",
    requestSaved: (name) => `✅ Demande acceptée, ${name} ! Ta chanson est en cours de création — elle arrivera directement ici dans le chat quand elle sera prête.`,
    requestError: "Une erreur s'est produite. Réessaie ou contacte le support.",
    songCaption: (name) => `${name}, ta chanson personnelle est prête. Écoute-la en silence — c'est ta musique. ✨`,
    notifyFixed: (name) => `${name}, nous avons corrigé la détection de langue — ta prochaine chanson sera dans la bonne langue.\n\nSi tu veux une nouvelle version — ouvre l'app et crée une nouvelle demande. La première après la correction est gratuite.`,
    noSongInQueue: "Vérifié — tu n'as pas de chansons en attente de renvoi.\n\nSi ta chanson n'est pas arrivée :\n• Attends 15–20 minutes — elle est peut-être encore en génération\n• Assure-toi de ne pas avoir bloqué le bot et d'avoir appuyé sur «Démarrer»\n• Contacte le support — on l'enverra manuellement",
    pendingHint: "\n\n🎁 Tu as une demande en attente d'activation du cadeau. Ouvre l'app (bouton menu dans le chat) et appuie sur «Obtenir gratuitement».",
    cooldown: (m) => `Attends encore ${m} min. — le renvoi est limité à une fois toutes les 10 minutes.`,
    noUser: "Impossible d'identifier l'utilisateur. Réessaie ou contacte le support.",
    resendOk: (title) => `🎵 Je renvoie ta chanson «${title}»...`,
    resendErr: "Erreur lors du renvoi. Contacte le support.",
  },
};
function bMsg(ctx, key, ...args) {
  const lang = getUserLang(ctx);
  const msg = BOT_MSGS[lang]?.[key] || BOT_MSGS.ru[key];
  return typeof msg === 'function' ? msg(...args) : msg;
}

// Защита от злоупотреблений: кулдаун 10 мин между попытками повторной отправки
const resendCooldownMs = 10 * 60 * 1000;
const resendLastAttempt = new Map();

// Пользователь пишет «песня не пришла» или нажимает кнопку — пробуем повторно отправить не доставленные
async function handleSongNotArrived(ctx) {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId || !supabase || !BOT_TOKEN) {
    await ctx.reply(bMsg(ctx, 'noUser'));
    return;
  }
  const now = Date.now();
  const last = resendLastAttempt.get(telegramUserId) || 0;
  if (now - last < resendCooldownMs) {
    const minsLeft = Math.ceil((resendCooldownMs - (now - last)) / 60000);
    await ctx.reply(bMsg(ctx, 'cooldown', minsLeft));
    return;
  }
  resendLastAttempt.set(telegramUserId, now);
  try {
    const { data: rows } = await supabase
      .from("track_requests")
      .select("id,name,audio_url,title,delivery_status,generation_status")
      .eq("telegram_user_id", Number(telegramUserId))
      .not("audio_url", "is", null)
      .eq("generation_status", "delivery_failed")
      .order("created_at", { ascending: false })
      .limit(3);
    if (!rows?.length) {
      // Проверяем: может у пользователя заявка в ожидании оплаты, но он имеет право на первую песню бесплатно
      const { data: pendingRow } = await supabase
        .from("track_requests")
        .select("id")
        .eq("telegram_user_id", Number(telegramUserId))
        .eq("generation_status", "pending_payment")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const trialAvailable = await isTrialAvailable(telegramUserId, "first_song_gift");
      const pendingHint = (pendingRow && trialAvailable) ? bMsg(ctx, 'pendingHint') : "";
      await ctx.reply(bMsg(ctx, 'noSongInQueue') + pendingHint);
      return;
    }
    let sent = 0;
    for (const row of rows) {
      try {
        const rowLang = row.language || "ru";
        const rowName = row.name || "Друг";
        const resendCaptions = {
          ru: `${rowName}, твоя персональная песня готова. Слушай в тишине — это твоя музыка. ✨`,
          uk: `${rowName}, твоя персональна пісня готова. Слухай у тиші — це твоя музика. ✨`,
          en: `${rowName}, your personal song is ready. Listen in silence — this is your music. ✨`,
          de: `${rowName}, dein persönliches Lied ist fertig. Höre es in Stille — das ist deine Musik. ✨`,
          fr: `${rowName}, ta chanson personnelle est prête. Écoute-la en silence — c'est ta musique. ✨`,
        };
        const payload = {
          chat_id: String(telegramUserId),
          audio: row.audio_url,
          caption: resendCaptions[rowLang] || resendCaptions.ru,
        };
        if (row.title) payload.title = String(row.title).slice(0, 64);
        if (rowName) payload.performer = String(rowName).slice(0, 64);
        let res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(payload).toString(),
        });
        let data = await res.json().catch(() => ({}));
        if (!data.ok && /chat not found|user not found|EAI_AGAIN|ECONNRESET/i.test(data.description || "")) {
          await new Promise((r) => setTimeout(r, 2000));
          res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(payload).toString(),
          });
          data = await res.json().catch(() => ({}));
        }
        if (data.ok) {
          sent++;
          const now = new Date().toISOString();
          await supabase
            .from("track_requests")
            .update({ delivery_status: "sent", generation_status: "completed", delivered_at: now, error_message: null, updated_at: now })
            .eq("id", row.id);
        }
      } catch (e) {
        console.warn("[resend] Ошибка отправки", row.id, e?.message);
      }
    }
    if (sent > 0) {
      const sentMsgs = {
        ru: `✅ Отправил тебе ${sent} песню(и). Проверь чат — они должны появиться.\n\nСледующая попытка — через 10 минут.`,
        uk: `✅ Надіслав тобі ${sent} пісню(і). Перевір чат — вони мають з'явитися.\n\nНаступна спроба — через 10 хвилин.`,
        en: `✅ Sent you ${sent} song(s). Check your chat — they should appear now.\n\nNext retry available in 10 minutes.`,
        de: `✅ ${sent} Lied(er) wurde(n) gesendet. Prüfe deinen Chat — sie sollten jetzt erscheinen.\n\nNächster Versuch in 10 Minuten.`,
        fr: `✅ J'ai envoyé ${sent} chanson(s). Vérifie ton chat — elles devraient apparaître.\n\nProchain essai dans 10 minutes.`,
      };
      await ctx.reply(sentMsgs[getUserLang(ctx)] || sentMsgs.ru);
    } else {
      const failMsgs = {
        ru: "Не удалось отправить — возможно, чат был удалён. Напиши /start и попробуй снова, или обратись в поддержку.",
        uk: "Не вдалося надіслати — можливо, чат було видалено. Напиши /start і спробуй знову, або звернись до підтримки.",
        en: "Failed to send — the chat may have been deleted. Type /start and try again, or contact support.",
        de: "Senden fehlgeschlagen — der Chat wurde möglicherweise gelöscht. Schreibe /start und versuche es erneut oder kontaktiere den Support.",
        fr: "Envoi échoué — le chat a peut-être été supprimé. Tape /start et réessaie, ou contacte le support.",
      };
      await ctx.reply(failMsgs[getUserLang(ctx)] || failMsgs.ru);
    }
  } catch (e) {
    console.error("[resend] Ошибка:", e?.message);
    await ctx.reply(bMsg(ctx, 'resendErr'));
  }
}

bot.hears(/^(песня не пришла|не пришла песня|не получил песню|не получила песню|повторно отправь|отправь снова|пісня не прийшла|не прийшла пісня|не отримав пісню|не отримала пісню|надішли ще раз|song not arrived|song didn.t arrive|resend song|send again|lied nicht angekommen|lied kam nicht an|sende nochmal|erneut senden|chanson pas arrivée|chanson n.est pas arrivée|renvoyer la chanson|renvoie la chanson)$/i, handleSongNotArrived);

// Кнопка «Песня не пришла?» из inline keyboard
bot.callbackQuery("song_not_arrived", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await handleSongNotArrived(ctx);
});

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

// ============================================================================
// ЧAТ ПОДДЕРЖКИ — двусторонний релей
// Переменная SUPPORT_CHAT_ID: Telegram ID чата/группы поддержки.
// Если не задана — используется первый ADMIN_IDS.
// Использование: пользователь пишет боту текст → пересылается в чат поддержки.
// Чтобы ответить: в чате поддержки ответь (Reply) на пересланное сообщение.
// ============================================================================
const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID
  ? parseInt(process.env.SUPPORT_CHAT_ID, 10)
  : (ADMIN_IDS[0] || null);

// Map: message_id пересланного сообщения → { userId, userName }
const supportRelay = new Map();

bot.on("message:text", async (ctx, next) => {
  const chatId = Number(ctx.chat?.id || 0);
  const userId = Number(ctx.from?.id || 0);
  const text = (ctx.message?.text || "").trim();

  // Если сообщение из чата поддержки — это может быть ответ оператора
  if (SUPPORT_CHAT_ID && chatId === SUPPORT_CHAT_ID) {
    const replyTo = ctx.message?.reply_to_message;
    if (replyTo) {
      const session = supportRelay.get(replyTo.message_id);
      if (session) {
        try {
          await bot.api.sendMessage(session.userId,
            `💬 *Поддержка YupSoul:*\n\n${text}`,
            { parse_mode: "Markdown" }
          );
          // Подтверждение оператору
          await ctx.react("✅").catch(() => {});
          console.log(`[Поддержка] Ответ доставлен пользователю ${session.userId} (${session.userName})`);
        } catch (e) {
          console.error("[Поддержка] Не удалось доставить ответ:", e?.message);
          await ctx.reply(`❌ Не удалось доставить: ${e?.message}`).catch(() => {});
        }
        return;
      }
    }
    return next();
  }

  // Пропускаем: команды, web_app_data уже обработаны выше
  if (text.startsWith("/")) return next();
  if (!SUPPORT_CHAT_ID) return next();

  // Пересылаем в чат поддержки
  const userName = ctx.from?.first_name || "Пользователь";
  const userTag = ctx.from?.username ? `@${ctx.from.username}` : "без username";
  const header = `🆘 *Сообщение от пользователя*\n👤 ${userName} (${userTag})\n🆔 \`${userId}\`\n\n`;
  try {
    const sent = await bot.api.sendMessage(
      SUPPORT_CHAT_ID,
      header + text,
      { parse_mode: "Markdown" }
    );
    // Сохраняем маппинг: message_id → userId, чтобы ответ дошёл обратно
    supportRelay.set(sent.message_id, { userId, userName });
    // Чтобы не копить бесконечно — чистим записи старше 7 дней (простой TTL)
    if (supportRelay.size > 500) {
      const firstKey = supportRelay.keys().next().value;
      supportRelay.delete(firstKey);
    }
    await ctx.reply("💬 Сообщение принято! Мы ответим в ближайшее время.\n\nЕсли вопрос срочный — можешь написать ещё раз, мы онлайн.");
    console.log(`[Поддержка] Сообщение от ${userId} (${userName}) переслано в чат поддержки`);
  } catch (e) {
    console.error("[Поддержка] Ошибка пересылки:", e?.message);
    return next();
  }
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
    const token = ADMIN_SECRET ? "token=" + encodeURIComponent(ADMIN_SECRET) : "";
    const apiOrigin = "api_origin=" + encodeURIComponent(BOT_PUBLIC_URL);
    const v = "v=" + Date.now(); // cache-bust — каждый раз новая ссылка
    const query = [token, apiOrigin, v].filter(Boolean).join("&");
    return BOT_PUBLIC_URL + "/admin?" + query;
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

// ── МЕНЮ КОМАНД ─────────────────────────────────────────────────────────────
// Пользователи видят только своё меню — без единого намёка на «Admin»
const userCommands = [
  { command: "start",        description: "🎵 Открыть YupSoul" },
  { command: "soulchat",     description: "💬 Разговор по душам" },
  { command: "get_analysis", description: "🔮 Моя расшифровка" },
];

// Полное меню — только для каждого конкретного админа
const adminCommands = [
  { command: "start",        description: "🎵 Открыть YupSoul" },
  { command: "soulchat",     description: "💬 Разговор по душам" },
  { command: "get_analysis", description: "🔮 Моя расшифровка" },
  { command: "admin",        description: "👑 Панель управления" },
  { command: "admin_check",  description: "👑 Проверка базы" },
  { command: "fixurl",       description: "🔧 Обновить ссылки Mini App" },
  { command: "ping",         description: "🔧 Проверка связи" },
];

// Всем приватным чатам — только пользовательское меню
bot.api.setMyCommands(userCommands, { scope: { type: "all_private_chats" } }).catch(() => {});
bot.api.setMyCommands(userCommands, { scope: { type: "all_private_chats" }, language_code: "ru" }).catch(() => {});

// Каждому админу — полное меню поверх общего
if (ADMIN_IDS.length) {
  for (const adminId of ADMIN_IDS) {
    bot.api.setMyCommands(adminCommands, { scope: { type: "chat", chat_id: adminId } }).catch(() => {});
  }
  console.log(`[Bot] Админские команды установлены для ${ADMIN_IDS.length} пользователей`);
}

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
// Подгружает имя и @username пользователя из user_profiles для уведомлений
async function fetchUserProfileForNotif(telegramUserId, fallbackName = null) {
  let name = fallbackName || null;
  let username = null;
  if (supabase && telegramUserId) {
    const { data } = await supabase
      .from("user_profiles")
      .select("name,tg_username")
      .eq("telegram_id", Number(telegramUserId))
      .maybeSingle()
      .catch(() => ({ data: null }));
    if (data?.tg_username) username = data.tg_username;
    if (!name && data?.name) name = data.name;
  }
  return { name, username };
}

// Строит строку пользователя для админских уведомлений
function buildAdminUserLine(telegramUserId, name, username) {
  return [
    name ? `👤 ${name}` : null,
    username ? `@${username}` : null,
    `[ID ${telegramUserId}](tg://user?id=${telegramUserId})`,
  ].filter(Boolean).join("  ·  ");
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
        .select("id,name,telegram_user_id,payment_status,payment_order_id,mode,payment_raw,payment_tx_id,generation_status,status")
        .eq("payment_order_id", orderId)
        .maybeSingle();
      row = r1.data || null;
      rowErr = r1.error || null;
    }
    if (rowErr) return res.status(500).json({ success: false, error: rowErr.message });
    if (!row && requestId) {
      const r2 = await supabase
        .from("track_requests")
        .select("id,name,telegram_user_id,payment_status,payment_order_id,mode,payment_raw,payment_tx_id,generation_status,status")
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
      let grantResult = await grantPurchaseBySku({ telegramUserId: row.telegram_user_id, sku: purchasedSku, source: "hot_payment", orderId: orderId || null });
      if (!grantResult?.ok) {
        console.error(`[webhook] grantPurchaseBySku failed: sku=${purchasedSku}, userId=${row.telegram_user_id}, error=${grantResult?.error} — retry in 5s`);
        // Retry once after 5 seconds (защита от transient Supabase errors)
        await new Promise(r => setTimeout(r, 5000));
        grantResult = await grantPurchaseBySku({ telegramUserId: row.telegram_user_id, sku: purchasedSku, source: "hot_payment_retry", orderId: orderId || null });
        if (!grantResult?.ok) {
          console.error(`[webhook] grantPurchaseBySku retry also failed: sku=${purchasedSku}, userId=${row.telegram_user_id}, error=${grantResult?.error}`);
        } else {
          console.log(`[webhook] grantPurchaseBySku retry ok: sku=${purchasedSku}, userId=${row.telegram_user_id}`);
        }
      } else {
        console.log(`[webhook] grantPurchaseBySku ok: sku=${purchasedSku}, userId=${row.telegram_user_id}${grantResult.already_active ? " (already_active)" : ""}`);
      }

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
        const scProf = await fetchUserProfileForNotif(row.telegram_user_id, row.name);
        const scUserLine = buildAdminUserLine(row.telegram_user_id, scProf.name, scProf.username);
        const scPaidAt = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        for (const adminId of ADMIN_IDS) {
          bot.api.sendMessage(
            adminId,
            `💬 *Soul Chat куплен*\n` +
            `${scUserLine}\n` +
            `💵 Сумма: *${body.amount || "?"} ${body.currency || "USDT"}*\n` +
            `📅 Оплачено: ${scPaidAt} МСК\n` +
            `🆔 Заявка: \`${shortId}\``
          , { parse_mode: "Markdown" }).catch(() => {});
        }
      } else if (["soul_basic_sub", "soul_plus_sub", "master_monthly"].includes(purchasedSku)) {
        // Активирована подписка
        const subPlanInfo = PLAN_META[purchasedSku] || { name: purchasedSku, tracks: 0 };
        const renewAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const renewStr = renewAt.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
        const shortId = String(row.id || "").slice(0, 8);

        bot.api.sendMessage(
          row.telegram_user_id,
          `✨ *Подписка ${subPlanInfo.name} активирована!*\n\n` +
          `Твои *${subPlanInfo.tracks} треков в месяц* ждут тебя.\n` +
          `Подписка действует до: *${renewStr}*\n\n` +
          `Открой YupSoul и создай свою первую песню этого месяца ↓`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "🎵 Открыть YupSoul", web_app: { url: MINI_APP_STABLE_URL } }]],
            },
          }
        ).catch((e) => console.warn("[webhook] notify subscription user:", e?.message));

        const subProf = await fetchUserProfileForNotif(row.telegram_user_id, row.name);
        const subUserLine = buildAdminUserLine(row.telegram_user_id, subProf.name, subProf.username);
        const subPaidAt = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        for (const adminId of ADMIN_IDS) {
          bot.api.sendMessage(
            adminId,
            `💎 *Новая подписка!*\n` +
            `📦 Тариф: *${subPlanInfo.name}*\n` +
            `${subUserLine}\n` +
            `💵 Сумма: *${body.amount || "?"} ${body.currency || "USDT"}*\n` +
            `📅 Оплачено: ${subPaidAt} МСК\n` +
            `🔑 До: ${renewStr}\n` +
            `🆔 Заявка: \`${shortId}\``
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
        const songSkuLabels = {
          single_song: "Одиночная песня",
          couple_song: "Песня пары",
          transit_energy_song: "Транзитная энергия",
          deep_analysis_addon: "Глубокий анализ",
          extra_regeneration: "Повторная генерация",
        };
        const skuLabel = songSkuLabels[purchasedSku] || purchasedSku;
        const songProf = await fetchUserProfileForNotif(row.telegram_user_id, row.name);
        const songUserLine = buildAdminUserLine(row.telegram_user_id, songProf.name, songProf.username);
        const songPaidAt = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        for (const adminId of ADMIN_IDS) {
          bot.api.sendMessage(
            adminId,
            `🎵 *Новая оплата!*\n` +
            `📦 Тип: *${skuLabel}*\n` +
            `${songUserLine}\n` +
            `💵 Сумма: *${body.amount || "?"} ${body.currency || "USDT"}*\n` +
            `📅 Оплачено: ${songPaidAt} МСК\n` +
            `🆔 Заявка: \`${shortId}\``
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

// Проверка, может ли бот писать в чат пользователю (чтобы избежать «Чат не найден» при доставке песни)
app.post("/api/check-chat", express.json(), asyncApi(async (req, res) => {
  const initData = req.body?.initData ?? req.headers["x-telegram-init"];
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) {
    return res.status(401).json({ ok: false, chat_available: false, error: "Неверные данные. Открой приложение из чата с ботом." });
  }
  if (!BOT_TOKEN) return res.status(503).json({ ok: false, chat_available: false, error: "Бот не настроен" });
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`;
  const body = new URLSearchParams({ chat_id: String(telegramUserId), action: "typing" });
  const apiRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await apiRes.json().catch(() => ({}));
  const desc = (data.description || "").toLowerCase();
  const chatUnavailable = !data.ok && (
    /chat not found/i.test(desc) ||
    /user not found/i.test(desc) ||
    /bot was blocked/i.test(desc) ||
    /have no rights to send/i.test(desc)
  );
  if (chatUnavailable) {
    return res.json({
      ok: false,
      chat_available: false,
      error: "Чат с ботом недоступен. Нажмите «Старт» в боте (или отправьте любое сообщение), затем вернитесь сюда и отправьте заявку снова.",
    });
  }
  return res.json({ ok: true, chat_available: true });
}));

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

// ── СТАТУС БОТА (запустил ли пользователь бота) ─────────────────────────────
app.post("/api/user/bot-status", express.json(), asyncApi(async (req, res) => {
  const initData = req.body?.initData ?? req.headers["x-telegram-init"];
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ error: "Unauthorized" });
  if (!supabase) return res.json({ started: true }); // без базы не блокируем
  const { data, error } = await supabase
    .from("user_profiles")
    .select("telegram_id")
    .eq("telegram_id", Number(telegramUserId))
    .maybeSingle();
  if (error && /does not exist|relation/i.test(error?.message || "")) {
    return res.json({ started: true }); // таблица не создана — не блокируем
  }
  return res.json({ started: !!data });
}));

// ── АВАТАР ПОЛЬЗОВАТЕЛЯ ──────────────────────────────────────────────────────
app.post("/api/user/avatar", express.json({ limit: "3mb" }), asyncApi(async (req, res) => {
  const initData = req.body?.initData ?? req.headers["x-telegram-init"];
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ error: "Unauthorized" });
  if (!supabase) return res.status(503).json({ error: "База недоступна" });

  const base64 = req.body?.avatar_base64;
  if (!base64 || typeof base64 !== "string") return res.status(400).json({ error: "Нет данных изображения" });

  // Обрезаем data-url префикс
  const raw = base64.replace(/^data:image\/[a-z]+;base64,/, "");
  if (raw.length > 2 * 1024 * 1024) return res.status(413).json({ error: "Файл слишком большой (макс. 2 МБ)" });

  const buf = Buffer.from(raw, "base64");
  const filename = `avatar_${telegramUserId}.jpg`;
  let avatarUrl = null;

  // Пробуем Supabase Storage
  try {
    const { error: upErr } = await supabase.storage
      .from("user-avatars")
      .upload(filename, buf, { contentType: "image/jpeg", upsert: true });

    if (!upErr) {
      const { data: urlData } = supabase.storage.from("user-avatars").getPublicUrl(filename);
      avatarUrl = urlData?.publicUrl || null;
    }
  } catch (_) {}

  // Fallback: сохраняем сжатый base64 прямо в профиль (только если маленький)
  if (!avatarUrl) {
    if (raw.length <= 150_000) {
      avatarUrl = base64; // храним data-url
    } else {
      return res.status(507).json({ error: "Хранилище недоступно, загрузите фото меньшего размера" });
    }
  }

  const { error } = await supabase
    .from("user_profiles")
    .upsert({ telegram_id: Number(telegramUserId), avatar_url: avatarUrl, updated_at: new Date().toISOString() }, { onConflict: "telegram_id" });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, avatar_url: avatarUrl });
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
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  });
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
  const stats = { total: rows.length, pending: 0, processing: 0, pending_payment: 0, cancelled: 0, astro_calculated: 0, lyrics_generated: 0, suno_processing: 0, completed: 0, delivery_failed: 0, failed: 0 };
  rows.forEach((r) => {
    const s = (r.generation_status ?? r.status) || "pending";
    if (s === "completed") stats.completed++;
    else if (s === "delivery_failed") stats.delivery_failed++;
    else if (s === "failed") stats.failed++;
    else if (s === "cancelled") stats.cancelled++;
    else if (s === "pending_payment") stats.pending_payment++;
    else if (s === "processing") stats.processing++;
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
  const requestIdSearch = String(req.query?.request_id || req.query?.id || "").trim().toLowerCase().replace(/[^0-9a-f-]/g, "");
  const userIdSearch = String(req.query?.user_id || req.query?.telegram_user_id || "").trim().replace(/[^0-9]/g, "");
  const fullSelect = "id,name,gender,birthdate,birthplace,person2_name,person2_gender,person2_birthdate,person2_birthplace,status,generation_status,delivery_status,delivered_at,created_at,audio_url,mode,request,generation_steps,payment_status,payment_provider,promo_code,promo_discount_amount,payment_amount,telegram_user_id,error_message";
  let q = supabase.from("track_requests").select(fullSelect).order("created_at", { ascending: false }).limit(userIdSearch || requestIdSearch ? 200 : limit);
  if (userIdSearch) {
    q = q.eq("telegram_user_id", Number(userIdSearch));
  }
  if (statusFilter === "pending") q = q.in("generation_status", ["pending", "processing", "astro_calculated", "lyrics_generated", "suno_processing"]);
  else if (statusFilter === "pending_payment") q = q.eq("generation_status", "pending_payment");
  else if (statusFilter === "completed") q = q.eq("generation_status", "completed");
  else if (statusFilter === "delivery_failed") q = q.eq("generation_status", "delivery_failed");
  else if (statusFilter === "failed") q = q.eq("generation_status", "failed");
  else if (statusFilter === "cancelled") q = q.eq("generation_status", "cancelled");
  let result = await q;
  if (requestIdSearch && result.data && result.data.length) {
    result.data = result.data.filter((r) => (r.id || "").toLowerCase().startsWith(requestIdSearch));
    if (result.data.length > 50) result.data = result.data.slice(0, 50);
  }
  if (result.error && /does not exist|column/i.test(result.error.message)) {
    const minSelect = "id, name, status, created_at, request, telegram_user_id";
    let q2 = supabase.from("track_requests").select(minSelect).order("created_at", { ascending: false }).limit(limit);
    if (statusFilter === "completed") q2 = q2.eq("status", "completed");
    else if (statusFilter === "failed") q2 = q2.eq("status", "failed");
    result = await q2;
  }
  if (result.error) return res.status(500).json({ success: false, error: result.error.message });
  // Обогащаем tg_username отдельным запросом (нет FK между таблицами)
  const rows = result.data || [];
  try {
    const tgIds = [...new Set(rows.map(r => r.telegram_user_id).filter(Boolean).map(Number))];
    if (tgIds.length) {
      const { data: profiles } = await supabase
        .from("user_profiles").select("telegram_id,tg_username").in("telegram_id", tgIds);
      if (profiles?.length) {
        const umap = Object.fromEntries(profiles.map(p => [String(p.telegram_id), p.tg_username]));
        rows.forEach(r => { r.tg_username = umap[String(r.telegram_user_id)] || null; });
      }
    }
  } catch (_) { /* tg_username недоступен — не критично */ }
  return res.json({ success: true, data: rows });
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
  const fullCols = "id,name,gender,birthdate,birthplace,birthtime,birthtime_unknown,mode,person2_name,person2_gender,person2_birthdate,person2_birthplace,person2_birthtime,person2_birthtime_unknown,transit_date,transit_time,transit_location,transit_intent,deepseek_response,lyrics,audio_url,request,created_at,status,generation_status,delivery_status,error_message,llm_truncated,generation_steps,delivered_at,payment_status,payment_provider,promo_code,promo_discount_amount,payment_amount,telegram_user_id";
  const coreCols = "id,name,gender,birthdate,birthplace,birthtime,birthtime_unknown,mode,person2_name,person2_gender,person2_birthdate,person2_birthplace,person2_birthtime,person2_birthtime_unknown,transit_date,transit_time,transit_location,transit_intent,deepseek_response,lyrics,audio_url,request,created_at,status,generation_status,delivery_status,error_message,delivered_at";
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
  // Обогащаем tg_username отдельным запросом (нет FK между таблицами)
  try {
    if (row.telegram_user_id) {
      const { data: prof } = await supabase
        .from("user_profiles").select("tg_username").eq("telegram_id", row.telegram_user_id).maybeSingle();
      row.tg_username = prof?.tg_username || null;
    }
  } catch (_) { row.tg_username = null; }
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
  // Читаем текущий статус — если уже в работе, не откатываем
  const { data: cur } = await supabase.from("track_requests").select("generation_status").eq("id", id).maybeSingle();
  const curGs = cur?.generation_status || "";
  const shouldAdvance = ["pending_payment"].includes(curGs);
  const { error: updErr } = await supabase
    .from("track_requests")
    .update({
      payment_status: "paid",
      payment_provider: req.body?.provider || "admin",
      ...(shouldAdvance ? { generation_status: "pending" } : {}),
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
    const sendPayload = {
      chat_id: String(telegram_user_id),
      audio: audio_url,
      caption,
    };
    let audioRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(sendPayload).toString(),
    });
    let audioData = await audioRes.json().catch(() => ({}));
    if (!audioData.ok && /chat not found|user not found|EAI_AGAIN|ECONNRESET/i.test(audioData.description || "")) {
      await new Promise((r) => setTimeout(r, 2000));
      audioRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(sendPayload).toString(),
      });
      audioData = await audioRes.json().catch(() => ({}));
    }
    if (!audioData.ok) {
      const rawError = audioData.description || "Ошибка Telegram API";
      const friendlyError = /chat not found/i.test(rawError)
        ? "Чат не найден. Попросите пользователя нажать «Старт» в боте (или отправить любое сообщение), затем повторить доставку из админки или пусть напишет боту «песня не пришла»."
        : rawError;
      await supabase
        .from("track_requests")
        .update({
          delivery_status: "failed",
          generation_status: "delivery_failed",
          error_message: rawError.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      return res.status(500).json({ success: false, error: friendlyError });
    }
    await supabase
      .from("track_requests")
      .update({
        delivery_status: "sent",
        generation_status: "completed",
        delivered_at: new Date().toISOString(),
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
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

// ===== ВАРИАНТ 1: поиск заявок с неверным языком =====
app.get("/api/admin/wrong-language", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });

  const fromLang = req.query.from_lang || "ru";
  const toLang = req.query.to_lang || "uk";

  // Находим пользователей, у которых в user_profiles сохранён нужный язык
  const { data: profiles } = await supabase
    .from("user_profiles")
    .select("telegram_id, name, language")
    .eq("language", toLang);

  const targetUserIds = (profiles || []).map(p => Number(p.telegram_id));

  // Находим их заявки с fromLang
  let query = supabase
    .from("track_requests")
    .select("id, telegram_user_id, name, language, generation_status, created_at")
    .eq("language", fromLang)
    .in("generation_status", ["completed", "delivery_failed"]);

  if (targetUserIds.length > 0) {
    query = query.in("telegram_user_id", targetUserIds);
  }

  const { data: rows, error } = await query.order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ success: false, error: error.message });

  return res.json({ success: true, count: rows?.length || 0, rows: rows || [] });
}));

// ===== ВАРИАНТ 1: перевести заявки на новый язык и поставить в очередь =====
app.post("/api/admin/requeue-wrong-language", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });

  const { ids, to_lang } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, error: "Укажите массив ids" });
  if (!to_lang) return res.status(400).json({ success: false, error: "Укажите to_lang" });

  const { error } = await supabase
    .from("track_requests")
    .update({
      language: to_lang,
      generation_status: "pending",
      status: "pending",
      audio_url: null,
      suno_task_id: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);

  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.json({ success: true, requeued: ids.length, language: to_lang });
}));

// ===== ВАРИАНТ 2: рассылка уведомлений пользователям с delivery_failed =====
app.post("/api/admin/notify-delivery-failed", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  if (!BOT_TOKEN) return res.status(503).json({ success: false, error: "BOT_TOKEN не задан" });

  // Находим уникальных пользователей с delivery_failed заявками
  const { data: rows, error } = await supabase
    .from("track_requests")
    .select("telegram_user_id, name, language")
    .eq("generation_status", "delivery_failed")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });

  // Дедупликация по telegram_user_id
  const seen = new Set();
  const users = (rows || []).filter(r => {
    if (seen.has(r.telegram_user_id)) return false;
    seen.add(r.telegram_user_id);
    return true;
  });

  const results = { sent: 0, failed: 0, users: users.length };

  for (const user of users) {
    const lang = user.language || "ru";
    const name = user.name || "друг";
    const msgs = BOT_MSGS[lang] || BOT_MSGS.ru;
    const text = typeof msgs.notifyFixed === 'function' ? msgs.notifyFixed(name) : BOT_MSGS.ru.notifyFixed(name);
    const btnTexts = { ru: "🎵 Открыть YupSoul", uk: "🎵 Відкрити YupSoul", en: "🎵 Open YupSoul", de: "🎵 YupSoul öffnen", fr: "🎵 Ouvrir YupSoul" };
    const btnText = btnTexts[lang] || btnTexts.ru;

    try {
      await bot.api.sendMessage(user.telegram_user_id, text, {
        reply_markup: { inline_keyboard: [[{ text: btnText, web_app: { url: MINI_APP_STABLE_URL } }]] }
      });
      results.sent++;
    } catch (e) {
      console.warn("[notify-delivery-failed] Не удалось отправить пользователю", user.telegram_user_id, e?.message);
      results.failed++;
    }
    await new Promise(r => setTimeout(r, 100)); // задержка чтобы не спамить Telegram API
  }

  return res.json({ success: true, ...results });
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
  const [access, lastReqId, profile] = await Promise.all([
    getSoulChatAccess(telegramUserId),
    getLastCompletedRequestForUser(telegramUserId),
    getUserProfileForSoulChat(telegramUserId),
  ]);
  const hasProfile = !!(profile && profile.name && profile.birthdate);
  return res.json({
    success: true,
    allowed: !!access.allowed,
    trial_available: !!access.trial_available,
    reason: access.reason || null,
    source: access.source || null,
    expires_at: access.expires_at || null,
    last_request_id: lastReqId || null,
    has_profile: hasProfile,
    is_master: !!access.is_master,
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
  const requestId2 = String(body.request_id_2 || "").trim();
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
  const result = await runSoulChat({ requestId, requestId2, question, telegramUserId, isAdminCaller });
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });

  // Сохраняем диалог в историю (не блокируем ответ на ошибку записи)
  if (supabase) {
    supabase.from("soul_chat_sessions").insert({
      telegram_user_id: Number(telegramUserId),
      track_request_id: result.request?.id || null,
      question,
      answer: result.answer,
      source: result.source || access.source || null,
      request_id_2: (requestId2 && UUID_REGEX.test(requestId2)) ? requestId2 : null,
    }).then(() => {}).catch((e) => console.warn("[soul-chat] save session:", e?.message));
  }

  return res.json({
    success: true,
    data: {
      request_id: result.request?.id || null,
      name: result.request?.name || null,
      answer: result.answer,
      expires_at: access.expires_at || null,
      source: access.source || null,
    },
  });
}));

// История диалогов Soul Chat (последние 50 сообщений)
app.get("/api/soul-chat/history", asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });

  const { data, error } = await supabase
    .from("soul_chat_sessions")
    .select("id,question,answer,created_at")
    .eq("telegram_user_id", Number(telegramUserId))
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ success: false, error: error.message });
  // Возвращаем в хронологическом порядке (oldest first)
  const messages = (data || []).reverse();
  return res.json({ success: true, messages });
}));

// Карточки пользователя для синастрии (только для тарифа Лаборатория)
app.get("/api/user/cards", asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || req.query?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });
  const { data } = await supabase
    .from("track_requests")
    .select("id,name,birthdate,birthplace,mode,person2_name,person2_birthdate,created_at")
    .eq("telegram_user_id", telegramUserId)
    .not("mode", "eq", "soul_chat_day")
    .in("generation_status", ["completed", "done"])
    .order("created_at", { ascending: false })
    .limit(20);
  return res.json({ success: true, cards: data || [] });
}));

// Сохраняет tg_username при каждом открытии Mini App
app.post("/api/user/sync", asyncApi(async (req, res) => {
  const initData = req.headers["x-telegram-init"] || req.body?.initData || "";
  const tgUser = parseUserFromInitData(initData, BOT_TOKEN);
  if (!tgUser?.id) return res.json({ success: false, error: "invalid_init_data" });
  if (!supabase) return res.json({ success: false, error: "db_unavailable" });
  const profileData = { telegram_id: Number(tgUser.id), updated_at: new Date().toISOString() };
  if (tgUser.username) profileData.tg_username = tgUser.username;
  if (tgUser.first_name) profileData.name = tgUser.first_name;
  await supabase.from("user_profiles").upsert(profileData, { onConflict: "telegram_id" }).catch(() => {});
  console.log(`[user/sync] ${tgUser.id} @${tgUser.username || "—"}`);
  return res.json({ success: true });
}));

// Публичный конфиг для фронтенда (не секреты)
app.get("/api/config", (req, res) => {
  res.json({
    bot_username: RESOLVED_BOT_USERNAME || "Yup_Soul_bot",
    support_username: SUPPORT_TG_USERNAME || RESOLVED_BOT_USERNAME || "Yup_Soul_bot",
  });
});

app.get("/api/pricing/catalog", asyncApi(async (req, res) => {
  const initData = req.headers["x-telegram-init"] || req.query?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  const catalog = await getPricingCatalog();
  
  console.log("[Pricing Catalog] Запрос от пользователя:", telegramUserId || "неизвестен", "initData длина:", initData ? initData.length : 0);
  
  // ВАЖНО: Если telegramUserId === null (первый визит, проблемы с initData),
  // всегда возвращаем trialAvailable: true, чтобы пользователь мог попробовать бесплатно
  let trialAvailable = true;
  let hasSubscription = false;
  
  if (telegramUserId != null && Number.isInteger(Number(telegramUserId))) {
    console.log("[Pricing Catalog] Валидный telegramUserId, проверяем trial и подписку");
    trialAvailable = await isTrialAvailable(telegramUserId, "first_song_gift");
    hasSubscription = await hasActiveSubscription(telegramUserId);
    console.log("[Pricing Catalog] ✅ User ID:", telegramUserId, "Trial available:", trialAvailable, "Has subscription:", hasSubscription);
  } else {
    console.log("[Pricing Catalog] ⚠️ Нет telegramUserId (первый визит или проблемы с initData) → trial available: true (по умолчанию)");
  }
  
  const response = {
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
  };
  
  console.log("[Pricing Catalog] Ответ:", JSON.stringify({ trial_available: trialAvailable, has_subscription: hasSubscription }));
  
  return res.json(response);
}));

// --- РЕФЕРАЛЬНАЯ СИСТЕМА ---

app.get("/api/referral/stats", asyncApi(async (req, res) => {
  const initData = req.headers["x-telegram-init"] || req.query?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ error: "Unauthorized" });

  const code = await getOrCreateReferralCode(telegramUserId);
  const botUsername = RESOLVED_BOT_USERNAME || process.env.BOT_USERNAME || "Yup_Soul_bot";

  const [invitedRes, rewardedRes, profileRes] = await Promise.allSettled([
    supabase.from("referrals").select("*", { count: "exact", head: true }).eq("referrer_id", Number(telegramUserId)),
    supabase.from("referrals").select("*", { count: "exact", head: true }).eq("referrer_id", Number(telegramUserId)).eq("reward_granted", true),
    supabase.from("user_profiles").select("referral_credits").eq("telegram_id", Number(telegramUserId)).maybeSingle(),
  ]);

  return res.json({
    code,
    link: code ? `https://t.me/${botUsername}?start=ref_${code}` : null,
    invited_count: invitedRes.status === "fulfilled" ? (invitedRes.value.count || 0) : 0,
    rewarded_count: rewardedRes.status === "fulfilled" ? (rewardedRes.value.count || 0) : 0,
    credits: profileRes.status === "fulfilled" ? (profileRes.value.data?.referral_credits || 0) : 0,
  });
}));

// --- КОНЕЦ РЕФЕРАЛЬНОЙ СИСТЕМЫ ---

app.post("/api/promos/validate", express.json(), asyncApi(async (req, res) => {
  const initData = req.headers["x-telegram-init"] || req.body?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });
  const sku = String(req.body?.sku || "").trim();
  const code = normalizePromoCode(req.body?.promo_code || req.body?.code);
  if (!sku) return res.status(400).json({ success: false, error: "sku обязателен" });
  if (!code) return res.status(400).json({ success: false, error: "Промокод обязателен" });
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

// ── ПОДПИСКА: получить ссылку на оплату прямо из Mini App ───────────────────
app.post("/api/payments/subscription/checkout", express.json(), asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || req.body?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });

  const PLAN_MAP = { plan_basic: "soul_basic_sub", plan_plus: "soul_plus_sub", plan_master: "master_monthly" };
  const planKey = String(req.body?.plan_key || "").trim();
  const sku = PLAN_MAP[planKey];
  if (!sku) return res.status(400).json({ success: false, error: "Неверный plan_key" });

  const planInfo = PLAN_META[sku] || { name: sku, tracks: 0 };
  const priceData = await getSkuPrice(sku);
  if (!priceData) return res.status(400).json({ success: false, error: "Цена не найдена для SKU" });

  const itemId = pickHotItemId(sku);
  if (!itemId) return res.status(400).json({ success: false, error: "HOT_ITEM_ID не настроен" });

  // Проверяем активную подписку
  const existing = await getActiveSubscriptionFull(telegramUserId);
  if (existing && existing.plan_sku === sku) {
    return res.json({ success: false, already_subscribed: true, error: "Подписка уже активна" });
  }

  const orderId = crypto.randomUUID();
  const requestId = crypto.randomUUID();

  await supabase.from("track_requests").insert({
    id: requestId,
    telegram_user_id: Number(telegramUserId),
    name: String(req.body?.name || ""),
    mode: `sub_${sku}`,
    payment_status: "pending",
    payment_provider: "hot",
    payment_order_id: orderId,
    payment_amount: Number(priceData.price),
    payment_currency: priceData.currency || "USDT",
    payment_raw: JSON.stringify({ provider: "hot", sku, plan: planKey }),
    generation_status: "pending_payment",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const checkoutUrl = buildHotCheckoutUrl({
    itemId, orderId,
    amount: Number(priceData.price),
    currency: priceData.currency || "USDT",
    requestId, sku,
  });

  console.log(`[subscription/checkout] sku=${sku}, orderId=${orderId.slice(0, 8)}, userId=${telegramUserId}`);
  return res.json({
    success: true,
    checkout_url: checkoutUrl,
    plan_name: planInfo.name,
    price: priceData.price,
    currency: priceData.currency || "USDT",
  });
}));

// Fallback: пользователь вернулся по HOT Pay redirect но вебхук ещё не пришёл.
// Активируем подписку напрямую, если: user owns the request, mode=sub_*, created <2ч назад.
// Аудит: source = "user_claimed_no_webhook" для ручной проверки.
app.post("/api/subscription/claim", express.json(), asyncApi(async (req, res) => {
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
    .select("id,telegram_user_id,payment_status,mode,created_at,payment_order_id")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ success: false, error: "Заявка не найдена" });
  if (Number(data.telegram_user_id) !== Number(telegramUserId)) {
    return res.status(403).json({ success: false, error: "Нет доступа к этой заявке" });
  }
  // Только для режима подписки
  const mode = String(data.mode || "");
  if (!mode.startsWith("sub_")) {
    return res.status(400).json({ success: false, error: "Только для заявок-подписок" });
  }
  // Заявка не старше 2 часов
  const ageMs = Date.now() - new Date(data.created_at).getTime();
  if (ageMs > 2 * 60 * 60 * 1000) {
    return res.status(409).json({ success: false, error: "Заявка слишком старая" });
  }
  // Если уже есть активная подписка этого SKU — успех (idempotent)
  const sku = resolveSkuByMode(mode);
  const existing = await getActiveSubscriptionFull(telegramUserId);
  if (existing && existing.plan_sku === sku) {
    return res.json({ success: true, status: "already_active", plan_sku: sku });
  }
  // Логируем для аудита
  console.log(`[sub/claim] userId=${telegramUserId}, requestId=${requestId.slice(0,8)}, sku=${sku}, payStatus=${data.payment_status}, ageMin=${Math.round(ageMs/60000)}`);
  const grantResult = await grantPurchaseBySku({
    telegramUserId,
    sku,
    source: "user_claimed_no_webhook",
    orderId: data.payment_order_id || null,
  });
  if (!grantResult?.ok) {
    return res.status(500).json({ success: false, error: grantResult?.error || "grant_failed" });
  }
  return res.json({ success: true, status: "activated", plan_sku: sku });
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

// Отменяет незавершённую заявку пользователя (нажал крестик на баннере)
app.post("/api/my/pending-request/dismiss", express.json(), asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false });
  const initData = req.headers["x-telegram-init"] || req.body?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (!telegramUserId) return res.status(401).json({ ok: false });

  const requestId = String(req.body?.request_id || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, error: "request_id обязателен" });

  // Убеждаемся что заявка принадлежит этому пользователю
  const { data: row } = await supabase
    .from("track_requests")
    .select("id, generation_status")
    .eq("id", requestId)
    .eq("telegram_user_id", Number(telegramUserId))
    .maybeSingle();

  if (!row) return res.status(404).json({ ok: false, error: "Заявка не найдена" });
  if (row.generation_status !== "pending_payment") {
    return res.json({ ok: true, skipped: true }); // уже не в статусе ожидания — ок
  }

  await supabase
    .from("track_requests")
    .update({ generation_status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", requestId);

  console.log(`[Dismiss] Заявка ${requestId} отменена пользователем ${telegramUserId}`);
  return res.json({ ok: true });
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
    .select("id,telegram_user_id,payment_provider,payment_status,payment_order_id,payment_tx_id,payment_amount,payment_currency,payment_raw,paid_at,generation_status,status,mode")
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
    .select("id,telegram_user_id,payment_status,payment_order_id,status,generation_status,mode")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ success: false, error: "Заявка не найдена" });
  if (Number(data.telegram_user_id) !== Number(telegramUserId)) {
    return res.status(403).json({ success: false, error: "Нет доступа к этой заявке" });
  }
  const paid = String(data.payment_status || "").toLowerCase() === "paid";
  if (!paid) return res.status(409).json({ success: false, error: "Оплата не подтверждена" });
  // Подписки и Soul Chat Day: убеждаемся что подписка активна (вебхук мог не прийти)
  const isSubOrService = String(data.mode || "").startsWith("sub_") || data.mode === "soul_chat_day";
  if (isSubOrService) {
    const sku = resolveSkuByMode(data.mode);
    if (sku && data.mode !== "soul_chat_day") {
      // Идемпотентно: createOrRefreshSubscription вернёт already_active если подписка уже есть
      const grantResult = await grantPurchaseBySku({
        telegramUserId: data.telegram_user_id,
        sku,
        source: "hot_payment_confirm_fallback",
      });
      if (!grantResult?.ok) {
        console.error(`[confirm] grantPurchaseBySku failed: sku=${sku}, userId=${data.telegram_user_id}, error=${grantResult?.error}`);
      } else {
        console.log(`[confirm] sub activated: sku=${sku}, userId=${data.telegram_user_id}${grantResult.already_active ? " (already_active)" : " (NEW)"}`);
      }
    } else if (data.mode === "soul_chat_day") {
      // Soul Chat Day — тоже активируем через confirm как фолбек
      const orderId = data.payment_order_id || null;
      const dayResult = await activateSoulChatDay(data.telegram_user_id, orderId);
      if (!dayResult?.ok) {
        console.error(`[confirm] activateSoulChatDay failed: userId=${data.telegram_user_id}, error=${dayResult?.error}`);
      }
    }
    return res.json({ success: true, started: false, status: "subscription_active" });
  }
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

app.get("/api/subscription/status", asyncApi(async (req, res) => {
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const initData = req.headers["x-telegram-init"] || req.query?.initData || "";
  const telegramUserId = validateInitData(initData, BOT_TOKEN);
  if (telegramUserId == null) return res.status(401).json({ success: false, error: "Unauthorized" });

  const sub = await getActiveSubscriptionFull(telegramUserId);
  const planSku = sub?.plan_sku || null;
  const planMeta = planSku ? PLAN_META[planSku] : null;
  const tracksLimit = planMeta?.tracks ?? 0;
  const tracksUsed = planSku ? await countTracksUsedThisMonth(telegramUserId) : 0;
  const tracksRemaining = planSku ? Math.max(0, tracksLimit - tracksUsed) : 0;

  // Доступ к Soul Chat: Plus и Мастер — безлимитно (-1), Basic — по лимиту
  const soulchatLimit = planMeta?.soulchat ?? 0;
  const soulChatAccess = planSku ? (soulchatLimit === -1 || soulchatLimit > 0) : false;

  // Дата обновления (начало следующего месяца)
  const now = new Date();
  const renewalDate = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  return res.json({
    success: true,
    subscription_active: !!sub,
    plan_sku: planSku,
    plan_name: planMeta?.name ?? "Free",
    renew_at: sub?.renew_at ?? null,
    subscription_renewal_date: renewalDate,
    tracks_limit: tracksLimit,
    tracks_used_this_month: tracksUsed,
    tracks_remaining: tracksRemaining,
    soul_chat_access: soulChatAccess,
  });
}));

// Admin: ручная активация подписки для пользователя (когда вебхук не пришёл)
app.post("/api/admin/grant-subscription", express.json(), asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const userId = Number(req.body?.telegram_user_id);
  const planKey = String(req.body?.plan_key || "").trim(); // plan_basic | plan_plus | plan_master
  const PLAN_MAP = { plan_basic: "soul_basic_sub", plan_plus: "soul_plus_sub", plan_master: "master_monthly" };
  const sku = PLAN_MAP[planKey];
  if (!userId || !sku) {
    return res.status(400).json({ success: false, error: "Нужны telegram_user_id и plan_key (plan_basic|plan_plus|plan_master)" });
  }
  const result = await grantPurchaseBySku({ telegramUserId: userId, sku, source: "admin_manual" });
  if (!result?.ok) return res.status(500).json({ success: false, error: result?.error || "grant_failed" });
  console.log(`[admin/grant-sub] admin=${auth.id}, userId=${userId}, sku=${sku}${result.already_active ? " (already_active)" : " (GRANTED)"}`);
  return res.json({ success: true, already_active: result.already_active || false, sku, renew_at: result.renew_at });
}));

// Admin: статус подписки пользователя
app.get("/api/admin/user-subscription", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });
  const userId = Number(req.query?.telegram_user_id);
  if (!userId) return res.status(400).json({ success: false, error: "telegram_user_id обязателен" });
  const sub = await getActiveSubscriptionFull(userId);
  // Последние 5 заявок с режимом sub_*
  const { data: subRequests } = await supabase
    .from("track_requests")
    .select("id,mode,payment_status,payment_order_id,created_at,updated_at")
    .eq("telegram_user_id", userId)
    .like("mode", "sub_%")
    .order("created_at", { ascending: false })
    .limit(5);
  return res.json({ success: true, active_subscription: sub || null, recent_sub_requests: subRequests || [] });
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

app.get("/api/admin/referrals", asyncApi(async (req, res) => {
  const auth = resolveAdminAuth(req);
  if (!auth) return res.status(403).json({ success: false, error: "Доступ только для админа" });
  if (!supabase) return res.status(503).json({ success: false, error: "Supabase недоступен" });

  const [rowsRes, totalRes, rewardedRes] = await Promise.allSettled([
    supabase.from("referrals")
      .select("id, referrer_id, referee_id, created_at, activated_at, reward_granted, reward_granted_at")
      .order("created_at", { ascending: false }).limit(200),
    supabase.from("referrals").select("*", { count: "exact", head: true }),
    supabase.from("referrals").select("*", { count: "exact", head: true }).eq("reward_granted", true),
  ]);

  const rows = rowsRes.status === "fulfilled" ? (rowsRes.value.data || []) : [];
  const total = totalRes.status === "fulfilled" ? (totalRes.value.count || 0) : 0;
  const rewarded = rewardedRes.status === "fulfilled" ? (rewardedRes.value.count || 0) : 0;

  return res.json({ success: true, rows, total, rewarded });
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
  res.set({ "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache", "Expires": "0" });
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
      if (body.person2.relationship) saveData.person2_relationship = body.person2.relationship;
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
  
  // ── ПРОВЕРКА ПРОМОКОДА ДО resolveAccessForRequest ──────────────────────────────
  // Используем validatePromoForOrder — полная проверка: SKU, лимит пользователя, сроки.
  const promoCodeRaw = String(body.promo_code || body.promoCode || "").trim().toUpperCase();
  let promoGrantsAccess = false;
  let promoData = null;
  if (promoCodeRaw && supabase) {
    const sku = requestModeForAccess === "couple" ? "couple_song" : (requestModeForAccess === "transit" ? "transit_energy_song" : "single_song");
    const checked = await validatePromoForOrder({ promoCode: promoCodeRaw, sku, telegramUserId });
    if (checked.ok && checked.promo) {
      const skuPrice = await getSkuPrice(sku);
      const baseAmount = skuPrice ? Number(skuPrice.price) : 0;
      const applied = applyPromoToAmount(baseAmount, checked.promo);
      if (applied.finalAmount === 0) {
        console.log("[submit-request] Промокод", promoCodeRaw, "тип:", checked.promo.type, "— даёт бесплатный доступ");
        promoGrantsAccess = true;
        promoData = { code: promoCodeRaw, id: checked.promo.id, discount: applied.discountAmount, finalAmount: 0 };
      }
    } else if (promoCodeRaw) {
      console.log("[submit-request] Промокод", promoCodeRaw, "отклонён:", checked.reason);
    }
  }
  
  const access = await resolveAccessForRequest({ telegramUserId, mode: requestModeForAccess });
  
  // Если промокод даёт 100% скидку — переопределяем access
  if (promoGrantsAccess && promoData) {
    access.allowed = true;
    access.source = "promo_free";
    console.log("[submit-request] Промокод", promoData.code, "активирован — доступ разрешён");
  }
  
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
    await sendPendingPaymentBotMessage(telegramUserId, requestId);
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
      await sendPendingPaymentBotMessage(telegramUserId, requestId);
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
  // Обновляем статус оплаты в зависимости от источника доступа
  let paymentProvider = "hot";
  let paymentStatus = "paid";
  if (access.source === "trial") { paymentProvider = "gift"; paymentStatus = "gift_used"; }
  else if (access.source === "subscription") { paymentProvider = "subscription"; paymentStatus = "subscription_active"; }
  else if (access.source === "promo_free" && promoData) { paymentProvider = "promo"; paymentStatus = "promo_applied"; }
  
  const updateData = {
    payment_provider: paymentProvider,
    payment_status: paymentStatus,
    updated_at: new Date().toISOString(),
  };
  
  // Если промокод — сохраняем код и discount
  if (access.source === "promo_free" && promoData) {
    updateData.promo_code = promoData.code;
    updateData.payment_amount = 0;
    updateData.payment_currency = "USDT";
    // Записываем использование промокода
    await supabase.from("promo_redemptions").insert({
      promo_code_id: promoData.id,
      telegram_user_id: Number(telegramUserId),
      request_id: requestId,
      discount_amount: promoData.discount,
      redeemed_at: new Date().toISOString(),
    }).catch((e) => console.warn("[submit-request] promo_redemptions insert:", e?.message));
    // Увеличиваем счётчик использований промокода
    await supabase.from("promo_codes").update({ used_count: (promoData.used_count || 0) + 1, updated_at: new Date().toISOString() }).eq("id", promoData.id).catch((e) => console.warn("[submit-request] promo_codes update:", e?.message));
  }
  
  await supabase.from("track_requests").update(updateData).eq("id", requestId);
  const mode = body.person1 && body.mode === "couple" ? "couple" : "single";
  console.log(`[API] Заявка ${requestId} сохранена — ГЕНЕРИРУЕМ ПЕСНЮ БЕСПЛАТНО (режим: ${mode})`);
  const successText =
    "✨ Твой звуковой ключ создаётся! Первый трек — в подарок 🎁\n\nОн придёт в этот чат, когда будет готов.";
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
    message: "✨ Твой звуковой ключ создаётся! Первый трек — в подарок 🎁\nПесня генерируется на сервере и придёт в этот чат. Можно закрыть окно — ничего не пропадёт. Спасибо ❤️",
  });
});

async function onBotStart(info) {
  if (info?.username) RESOLVED_BOT_USERNAME = info.username;
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

  // Уведомление админам о перезапуске — с кнопкой на новый URL (сбрасывает кэш в Telegram)
  if (ADMIN_IDS.length) {
    const time = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
    const text = `🔄 Бот обновлён и запущен.\n${time}\n\nНовый URL Mini App: \`${MINI_APP_URL}\`\n\nНажми кнопку чтобы открыть свежую версию:`;
    for (const adminId of ADMIN_IDS) {
      bot.api.sendMessage(adminId, text, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🚀 Открыть обновлённый YupSoul", web_app: { url: MINI_APP_URL } }]]
        }
      }).catch((e) => console.warn("[onStart] Уведомление админу", adminId, e?.message));
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

/** Интервал проверки заявок (мс): зависшие в processing и долго ожидающие pending. */
const DELIVERY_WATCHDOG_INTERVAL_MS = Math.max(60_000, parseInt(process.env.DELIVERY_WATCHDOG_INTERVAL_MS, 10) || 10 * 60_000);
/** Считаем заявку «зависшей» в обработке после стольких мс. */
const STALE_PROCESSING_MS = parseInt(process.env.STALE_PROCESSING_MS, 10) || 20 * 60 * 1000;
/** Считаем заявку «долго ожидающей», если в pending/paid дольше стольких мс. */
const PENDING_TOO_LONG_MS = parseInt(process.env.PENDING_TOO_LONG_MS, 10) || 15 * 60 * 1000;

let _deliveryWatchdogStarted = false;
/** Страховка доставки: раз в N минут проверяем зависшие (processing) и долго ожидающие (pending) заявки, перезапускаем воркер. */
function startDeliveryWatchdog() {
  if (!supabase || _deliveryWatchdogStarted) return;
  _deliveryWatchdogStarted = true;
  console.log("[Watchdog] Запуск: интервал", DELIVERY_WATCHDOG_INTERVAL_MS / 1000, "с, зависшие >", STALE_PROCESSING_MS / 60000, "мин, ожидание >", PENDING_TOO_LONG_MS / 60000, "мин");

  async function tick() {
    try {
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_MS).toISOString();
      const pendingThreshold = new Date(now.getTime() - PENDING_TOO_LONG_MS).toISOString();

      // 1) Зависшие в processing (воркер упал/таймаут) — сбрасываем в pending и перезапускаем одну
      const { data: stale } = await supabase
        .from("track_requests")
        .select("id,name,updated_at")
        .eq("generation_status", "processing")
        .lt("updated_at", staleThreshold)
        .order("updated_at", { ascending: true })
        .limit(5);
      if (stale?.length) {
        const ids = stale.map((r) => r.id);
        await supabase.from("track_requests").update({ status: "pending", generation_status: "pending", updated_at: now.toISOString() }).in("id", ids);
        const oldest = stale[0];
        console.log("[Watchdog] Зависшие в processing:", ids.length, "— сброшены в pending, перезапуск заявки", oldest.id);
        if (ADMIN_IDS.length && BOT_TOKEN) {
          const msg = `⏱ Заявка ${oldest.id} зависла в обработке > ${STALE_PROCESSING_MS / 60000} мин. Поставлена на перегенерацию.`;
          for (const adminId of ADMIN_IDS) {
            bot.api.sendMessage(adminId, msg).catch((e) => console.warn("[Watchdog] Уведомление админу:", e?.message));
          }
        }
        import("./workerSoundKey.js").then((m) => m.generateSoundKey(oldest.id)).catch((e) => console.error("[Watchdog] Ошибка перезапуска воркера:", e?.message));
        return;
      }

      // 2) Долго в pending при уже оплате — подхватываем одну заявку (воркер мог не запуститься)
      const { data: longPending } = await supabase
        .from("track_requests")
        .select("id,name,updated_at")
        .in("generation_status", ["pending", "astro_calculated", "lyrics_generated", "suno_processing"])
        .in("payment_status", ["paid", "gift_used", "subscription_active"])
        .lt("updated_at", pendingThreshold)
        .order("updated_at", { ascending: true })
        .limit(1);
      if (longPending?.length) {
        const r = longPending[0];
        console.log("[Watchdog] Долго ожидающая заявка:", r.id, "— запуск воркера");
        if (ADMIN_IDS.length && BOT_TOKEN) {
          const msg = `⏱ Заявка ${r.id} (${r.name || "—"}) ожидала генерации > ${PENDING_TOO_LONG_MS / 60000} мин. Запущен воркер.`;
          for (const adminId of ADMIN_IDS) {
            bot.api.sendMessage(adminId, msg).catch((e) => console.warn("[Watchdog] Уведомление админу:", e?.message));
          }
        }
        import("./workerSoundKey.js").then((m) => m.generateSoundKey(r.id)).catch((e) => console.error("[Watchdog] Ошибка запуска воркера:", e?.message));
      }
    } catch (e) {
      console.error("[Watchdog] Ошибка:", e?.message || e);
    }
  }

  tick();
  setInterval(tick, DELIVERY_WATCHDOG_INTERVAL_MS);
}

/** Раз в час: проверка, что все готовые песни (completed с audio_url) доставлены пользователям; повторная отправка при необходимости. */
const HOURLY_DELIVERY_CHECK_MS = Math.max(60 * 60 * 1000, parseInt(process.env.HOURLY_DELIVERY_CHECK_MS, 10) || 60 * 60 * 1000);
const HOURLY_DELIVERY_BATCH = Math.min(50, Math.max(5, parseInt(process.env.HOURLY_DELIVERY_BATCH, 10) || 20));
let _hourlyDeliveryCheckStarted = false;
function startHourlyDeliveryCheck() {
  if (!supabase || !BOT_TOKEN || _hourlyDeliveryCheckStarted) return;
  _hourlyDeliveryCheckStarted = true;
  console.log("[HourlyCheck] Запуск: интервал", HOURLY_DELIVERY_CHECK_MS / 60000, "мин, батч до", HOURLY_DELIVERY_BATCH);

  async function run() {
    try {
      const { data: rows } = await supabase
        .from("track_requests")
        .select("id,name,audio_url,telegram_user_id")
        .not("audio_url", "is", null)
        .or("delivered_at.is.null,delivery_status.neq.sent")
        .in("generation_status", ["completed", "delivery_failed"])
        .order("created_at", { ascending: true })
        .limit(HOURLY_DELIVERY_BATCH);
      if (!rows?.length) return;
      let sent = 0;
      let failed = 0;
      const now = new Date().toISOString();
      for (const row of rows) {
        try {
          const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              chat_id: String(row.telegram_user_id),
              audio: row.audio_url,
              caption: `🎵 ${row.name || "Друг"}, твоя персональная песня!\n\n— YupSoul`,
            }).toString(),
          });
          const data = await res.json().catch(() => ({}));
          if (data.ok) {
            sent++;
            await supabase
              .from("track_requests")
              .update({ delivery_status: "sent", generation_status: "completed", delivered_at: now, error_message: null, updated_at: now })
              .eq("id", row.id);
          } else {
            failed++;
            await supabase
              .from("track_requests")
              .update({
                delivery_status: "failed",
                generation_status: "delivery_failed",
                error_message: (data.description || "Ошибка доставки").slice(0, 500),
                updated_at: now,
              })
              .eq("id", row.id);
          }
        } catch (e) {
          failed++;
          console.warn("[HourlyCheck] Ошибка отправки", row.id, e?.message);
        }
      }
      if (sent > 0 || failed > 0) {
        console.log("[HourlyCheck] Проверка доставки: отправлено", sent, ", не доставлено", failed);
        if (ADMIN_IDS.length && BOT_TOKEN && (sent > 0 || failed > 0)) {
          const msg = `📬 Раз в час: проверка доставки.\nОтправлено пользователям: ${sent}.\nНе удалось доставить: ${failed}.`;
          for (const adminId of ADMIN_IDS) {
            bot.api.sendMessage(adminId, msg).catch((e) => console.warn("[HourlyCheck] Уведомление админу:", e?.message));
          }
        }
      }
    } catch (e) {
      console.error("[HourlyCheck] Ошибка:", e?.message || e);
    }
  }

  run();
  setInterval(run, HOURLY_DELIVERY_CHECK_MS);
}

function registerMasterRoutes(expressApp) {
  expressApp.get("/api/master/access", async (req, res) => {
    const initData = req.query?.initData ?? req.headers["x-telegram-init"];
    const telegramUserId = validateInitData(initData, BOT_TOKEN);
    if (telegramUserId == null) return res.status(401).json({ error: "Неверные данные авторизации" });
    const access = await hasMasterAccess(telegramUserId);
    if (!access) return res.json({ access: false });
    const nowIso = new Date().toISOString();
    const { data } = supabase
      ? await supabase.from("subscriptions").select("renew_at,source").eq("telegram_user_id", Number(telegramUserId)).eq("plan_sku", "master_monthly").eq("status", "active").gte("renew_at", nowIso).order("renew_at", { ascending: false }).limit(1).maybeSingle()
      : { data: null };
    return res.json({ access: true, renew_at: data?.renew_at ?? null, source: data?.source ?? null });
  });

  expressApp.post("/api/master/trial/start", async (req, res) => {
    const initData = req.body?.initData ?? req.headers["x-telegram-init"];
    const telegramUserId = validateInitData(initData, BOT_TOKEN);
    if (telegramUserId == null) return res.status(401).json({ error: "Неверные данные авторизации" });

    const alreadyHas = await hasMasterAccess(telegramUserId);
    if (alreadyHas) return res.json({ ok: true, already_active: true });

    if (supabase) {
      const { data: usedTrial } = await supabase.from("user_trials").select("id").eq("telegram_user_id", Number(telegramUserId)).eq("trial_key", "master_access").maybeSingle();
      if (usedTrial) return res.status(403).json({ error: "Пробный период уже был использован" });
    }

    const renewAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    if (supabase) {
      await supabase.from("user_trials").insert({ telegram_user_id: Number(telegramUserId), trial_key: "master_access", consumed_at: new Date().toISOString() });
      await supabase.from("subscriptions").insert({ telegram_user_id: Number(telegramUserId), plan_sku: "master_monthly", status: "active", renew_at: renewAt, source: "trial", updated_at: new Date().toISOString() });
    }
    return res.json({ ok: true, renew_at: renewAt, source: "trial" });
  });

  expressApp.post("/api/master/subscribe", async (req, res) => {
    const initData = req.body?.initData ?? req.headers["x-telegram-init"];
    const telegramUserId = validateInitData(initData, BOT_TOKEN);
    if (telegramUserId == null) return res.status(401).json({ error: "Неверные данные авторизации" });

    const sku = "master_monthly";
    const orderId = `master_${telegramUserId}_${Date.now()}`;

    let amount = 299, currency = "RUB";
    if (supabase) {
      const { data: cat } = await supabase.from("pricing_catalog").select("price,currency").eq("sku", sku).maybeSingle();
      if (cat) { amount = Number(cat.price); currency = cat.currency || "RUB"; }
    }

    const url = buildHotCheckoutUrl({ orderId, amount, currency, requestId: orderId, sku });
    return res.json({ ok: true, payment_url: url });
  });
}

if (process.env.RENDER_HEALTHZ_FIRST) {
  registerMasterRoutes(app);
  app.use("/api", createHeroesRouter(supabase, BOT_TOKEN));
  app.use("/api", apiNotFoundJson);
  globalThis.__EXPRESS_APP__ = app;
  if (WEBHOOK_URL) {
    startBotWithWebhook();
  } else {
    startBotWithPolling();
  }
  startDeliveryWatchdog();
  startHourlyDeliveryCheck();
} else {
  console.log("[HTTP] Слушаю порт", HEROES_API_PORT);
  registerMasterRoutes(app);
  app.use("/api", createHeroesRouter(supabase, BOT_TOKEN));
  app.use("/api", apiNotFoundJson);
  app.listen(HEROES_API_PORT, "0.0.0.0", () => {
    console.log("[HTTP] Порт открыт:", HEROES_API_PORT);
    if (WEBHOOK_URL) {
      startBotWithWebhook();
    } else {
      startBotWithPolling();
    }
    startDeliveryWatchdog();
    startHourlyDeliveryCheck();
  });
}
