/**
 * Долгоиграющий воркер для Render (Background Worker).
 * Раз в N минут обрабатывает одну заявку (астро → DeepSeek → Suno → отправка).
 * + CRON: автоматическое продление подписок T-Bank.
 * Запуск: node worker-loop.js
 */

import "dotenv/config";
import { runOnceWithAstro } from "./workerGenerate.js";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS) || 5 * 60 * 1000;
const SUBSCRIPTION_CHECK_INTERVAL_MS = Number(process.env.SUBSCRIPTION_CHECK_INTERVAL_MS) || 60 * 60 * 1000;

if (!process.env.DEEPSEEK_API_KEY || !process.env.SUNO_API_KEY) {
  console.warn("[WorkerLoop] В .env задай DEEPSEEK_API_KEY и SUNO_API_KEY — иначе генерация текста и музыки не заработает.");
}

// ── Supabase: один клиент на весь процесс ───────────────────────────────────
const _supabaseUrl = (process.env.SUPABASE_URL || "").trim();
const _supabaseKey = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const supabase = (_supabaseUrl && _supabaseKey) ? createClient(_supabaseUrl, _supabaseKey) : null;

// ── T-Bank CRON: автоматическое продление подписок ──────────────────────────

const TBANK_TERMINAL_KEY = (process.env.TBANK_TERMINAL_KEY || "").trim();
const TBANK_PASSWORD = (process.env.TBANK_PASSWORD || "").trim();
const TBANK_API_URL = (process.env.TBANK_API_URL || "https://securepay.tinkoff.ru/v2").trim().replace(/\/$/, "");
const _tbankNotifyBase = (process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || "").replace(/\/$/, "").replace(/\/app\/?$/, "");
const TBANK_NOTIFICATION_URL = (process.env.TBANK_NOTIFICATION_URL || (_tbankNotifyBase ? _tbankNotifyBase + "/api/payments/tbank/notification" : "")).trim();

function tbankToken(params) {
  const flat = { ...params, Password: TBANK_PASSWORD };
  delete flat.Token; delete flat.Receipt; delete flat.DATA; delete flat.Shops;
  const sorted = Object.keys(flat).sort();
  return crypto.createHash("sha256").update(sorted.map(k => String(flat[k] ?? "")).join(""), "utf8").digest("hex");
}

async function tbankCall(method, params) {
  const body = { ...params, TerminalKey: TBANK_TERMINAL_KEY };
  body.Token = tbankToken(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(`${TBANK_API_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[CRON T-Bank] ${method} HTTP ${resp.status}:`, text.slice(0, 200));
      return { Success: false, ErrorCode: String(resp.status), Message: `HTTP ${resp.status}` };
    }
    return await resp.json();
  } catch (e) {
    clearTimeout(timeout);
    console.error(`[CRON T-Bank] ${method} ERROR:`, e?.message || e);
    return { Success: false, ErrorCode: "NETWORK", Message: e?.message || "Network error" };
  }
}

let _renewalInProgress = false;

async function checkAndRenewSubscriptions() {
  if (!TBANK_TERMINAL_KEY || !supabase) return;

  // Защита от параллельного запуска
  if (_renewalInProgress) {
    console.log("[CRON T-Bank] Предыдущий цикл ещё не завершён, пропускаем");
    return;
  }
  _renewalInProgress = true;

  try {
    const now = new Date();

    // Оптимистичная блокировка: помечаем подписки как "renewing"
    const { data: expiring, error } = await supabase.from("subscriptions")
      .select("*")
      .eq("status", "active")
      .lte("renew_at", now.toISOString())
      .limit(20);

    if (error) {
      console.error("[CRON T-Bank] Ошибка запроса подписок:", error.message);
      return;
    }
    if (!expiring || expiring.length === 0) return;

    console.log(`[CRON T-Bank] Найдено ${expiring.length} подписок для продления`);

    for (const sub of expiring) {
      const userId = sub.telegram_user_id;
      const sku = sub.plan_sku || sub.sku || "soul_basic_sub";

      // Оптимистичная блокировка: обновляем только если status всё ещё active
      const { data: locked, error: lockErr } = await supabase.from("subscriptions")
        .update({ status: "renewing", updated_at: now.toISOString() })
        .eq("id", sub.id)
        .eq("status", "active")
        .select("id");

      if (lockErr || !locked || locked.length === 0) {
        console.log(`[CRON T-Bank] user=${userId}: подписка уже обрабатывается другим процессом`);
        continue;
      }

      const { data: card } = await supabase.from("tbank_cards")
        .select("rebill_id")
        .eq("telegram_user_id", Number(userId))
        .eq("active", true)
        .maybeSingle();

      if (!card?.rebill_id) {
        console.log(`[CRON T-Bank] user=${userId}: нет привязанной карты`);
        await supabase.from("subscriptions").update({
          status: "expired", updated_at: now.toISOString(),
        }).eq("id", sub.id);
        continue;
      }

      const priceMap = { soul_basic_sub: 1490, soul_plus_sub: 2490, master_monthly: 3990 };
      const amount = priceMap[sku] || 1490;
      const orderId = `tbank_recur_${userId}_${Date.now()}`;

      try {
        const initParams = {
          Amount: Math.round(amount * 100),
          OrderId: orderId,
          CustomerKey: String(userId),
          Description: `Продление подписки YupSoul (${sku})`,
          PayType: "O",
          OperationInitiatorType: "R",
        };
        if (TBANK_NOTIFICATION_URL) initParams.NotificationURL = TBANK_NOTIFICATION_URL;

        const initResult = await tbankCall("Init", initParams);

        if (!initResult.Success || String(initResult.ErrorCode) !== "0") {
          console.error(`[CRON T-Bank] Init failed user=${userId}:`, initResult.Message);
          await supabase.from("subscriptions").update({
            status: "payment_failed", updated_at: now.toISOString(),
          }).eq("id", sub.id);
          continue;
        }

        const chargeResult = await tbankCall("Charge", {
          PaymentId: String(initResult.PaymentId),
          RebillId: String(card.rebill_id),
        });

        if (!chargeResult.Success || String(chargeResult.ErrorCode) !== "0") {
          console.error(`[CRON T-Bank] Charge failed user=${userId}:`, chargeResult.Message);
          await supabase.from("subscriptions").update({
            status: "payment_failed", updated_at: now.toISOString(),
          }).eq("id", sub.id);
          continue;
        }

        const newRenewAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await supabase.from("subscriptions").update({
          renew_at: newRenewAt.toISOString(),
          updated_at: new Date().toISOString(),
          status: "active",
        }).eq("id", sub.id);

        await supabase.from("track_requests").insert({
          telegram_user_id: Number(userId),
          mode: sku,
          status: "paid",
          payment_provider: "tbank",
          payment_order_id: orderId,
          tbank_payment_id: String(initResult.PaymentId),
          payment_amount: amount,
          payment_currency: "RUB",
          paid_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });

        console.log(`[CRON T-Bank] Подписка продлена: user=${userId}, sku=${sku}, ${amount}₽, до ${newRenewAt.toISOString()}`);
      } catch (e) {
        console.error(`[CRON T-Bank] Ошибка user=${userId}:`, e?.message || e);
        await supabase.from("subscriptions").update({
          status: "active", updated_at: now.toISOString(),
        }).eq("id", sub.id).catch(() => {});
      }
    }
  } finally {
    _renewalInProgress = false;
  }
}

async function tick() {
  try {
    await runOnceWithAstro();
  } catch (e) {
    console.error("[WorkerLoop] Ошибка:", e?.message || e);
  }
}

console.log("[WorkerLoop] Запуск. Пайплайн: заявка → астро → DeepSeek → Suno → отправка. Интервал:", INTERVAL_MS / 1000, "с");
if (TBANK_TERMINAL_KEY) {
  console.log("[WorkerLoop] CRON T-Bank: проверка подписок каждые", SUBSCRIPTION_CHECK_INTERVAL_MS / 1000, "с");
  if (TBANK_NOTIFICATION_URL) console.log("[WorkerLoop] T-Bank NotificationURL:", TBANK_NOTIFICATION_URL);
}
tick();
setInterval(tick, INTERVAL_MS);

if (TBANK_TERMINAL_KEY) {
  setTimeout(() => checkAndRenewSubscriptions().catch(e => console.error("[CRON T-Bank]", e?.message || e)), 30000);
  setInterval(() => checkAndRenewSubscriptions().catch(e => console.error("[CRON T-Bank]", e?.message || e)), SUBSCRIPTION_CHECK_INTERVAL_MS);
}
