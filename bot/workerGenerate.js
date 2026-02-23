/**
 * Воркер полной автоматизации: заявка (pending + astro готов) → DeepSeek (текст) → Suno (аудио) → отправка в Telegram.
 * Запуск: node workerGenerate.js   или по крону каждые N минут.
 * Требует: .env с BOT_TOKEN, SUPABASE_*, DEEPSEEK_API_KEY, SUNO_API_KEY.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getRenderedPrompt, MAIN_PROMPT_NAME } from "./promptTemplates.js";
import { chatCompletion } from "./deepseek.js";
import { generateMusic, pollMusicResult } from "./suno.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

/**
 * Достаём из ответа LLM четыре части (алгоритм: docs/ALGORITHM.md):
 * 1) detailed_analysis — глубокий анализ из результата промта (Этап 1 + при необходимости Этап 2); именно он уходит пользователю в чат по запросу «расшифровка» / get_analysis
 * 2) style — один или два стиля для Suno
 * 3) lyrics — текст песни
 * 4) title — название песни
 */
function parseSongFromResponse(text) {
  if (!text || typeof text !== "string") return null;
  // Глубокий анализ = всё до ЭТАП 3 / ПЕСНЯ ДЛЯ / ЛИРИКА / «название»
  let detailed_analysis = "";
  let title = "";
  let lyrics = "";
  let style = "Ambient, Cinematic, Soul";

  const analysisEndMark = text.search(/\n\s*ПЕСНЯ ДЛЯ\s|ЭТАП 3|ЛИРИКА\s*:\s*|LYRICS\s*:\s*|«[^»]+»/i);
  if (analysisEndMark > 0) {
    detailed_analysis = text.slice(0, analysisEndMark).trim();
  } else {
    const firstGuillemet = text.indexOf("«");
    if (firstGuillemet > 0) detailed_analysis = text.slice(0, firstGuillemet).trim();
  }
  if (detailed_analysis.length > 50000) detailed_analysis = detailed_analysis.slice(0, 50000);

  const titleMatch = text.match(/«([^»]+)»/);
  if (titleMatch) title = titleMatch[1].trim();

  const styleMatch = text.match(/\[style:\s*([^\]]+)\]/i);
  if (styleMatch) style = styleMatch[1].trim().slice(0, 500);

  const lyricsStart = text.search(/\b(ЛИРИКА|LYRICS)\s*:\s*/i);
  if (lyricsStart >= 0) {
    const afterLabel = text.slice(lyricsStart);
    const endMark = afterLabel.search(/\n\s*MUSIC PROMPT|КЛЮЧЕВЫЕ ПРИНЦИПЫ|\[style:/i);
    lyrics = (endMark >= 0 ? afterLabel.slice(0, endMark) : afterLabel)
      .replace(/^(ЛИРИКА|LYRICS)\s*:\s*/i, "")
      .trim();
  }
  if (!lyrics && (text.includes("[Verse") || text.includes("[verse") || text.includes("[Chorus]"))) {
    const verseStart = text.search(/\[(?:Verse|verse|Chorus|chorus)/i);
    if (verseStart >= 0) {
      const untilEnd = text.slice(verseStart);
      const endMark = untilEnd.search(/\n\s*MUSIC PROMPT|КЛЮЧЕВЫЕ ПРИНЦИПЫ|\[style:/i);
      lyrics = endMark >= 0 ? untilEnd.slice(0, endMark).trim() : untilEnd.trim();
    }
  }
  if (!title && lyrics) title = "Sound Key";

  return {
    detailed_analysis: detailed_analysis || null,
    title,
    lyrics: lyrics.slice(0, 5000),
    style,
  };
}

/** Отправка аудио пользователю в Telegram по URL. При «chat not found» — одна повторная попытка через 2 сек. */
async function sendAudioToUser(telegramUserId, audioUrl, caption, title, performer) {
  if (!BOT_TOKEN || !telegramUserId) return { ok: false, error: "Нет BOT_TOKEN или chat_id" };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`;
  const params = {
    chat_id: String(telegramUserId),
    audio: audioUrl,
    caption: caption || "Твоя персональная песня готова. ✨",
  };
  if (title) params.title = String(title).slice(0, 64);
  if (performer) params.performer = String(performer).slice(0, 64);
  const body = new URLSearchParams(params);
  const opts = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() };
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (data.ok) return { ok: true };
  const errMsg = data.description || "Telegram API error";
  const retryable = /chat not found|user not found|EAI_AGAIN|ECONNRESET|timeout/i.test(errMsg);
  if (retryable) {
    await new Promise((r) => setTimeout(r, 2000));
    const res2 = await fetch(url, opts);
    const data2 = await res2.json().catch(() => ({}));
    if (data2.ok) return { ok: true };
    return { ok: false, error: data2.description || errMsg };
  }
  return { ok: false, error: errMsg };
}

/** Обработка одной заявки: LLM → Suno → отправка */
function getSongCaption(name, language) {
  const captions = {
    ru: `${name}, твоя персональная песня готова. Слушай в тишине — это твоя музыка. ✨`,
    uk: `${name}, твоя персональна пісня готова. Слухай у тиші — це твоя музика. ✨`,
    en: `${name}, your personal song is ready. Listen in silence — this is your music. ✨`,
    de: `${name}, dein persönliches Lied ist fertig. Höre es in Stille — das ist deine Musik. ✨`,
    fr: `${name}, ta chanson personnelle est prête. Écoute-la en silence — c'est ta musique. ✨`,
  };
  return captions[language] || captions.ru;
}

async function processOneRequest(row) {
  const id = row.id;
  const telegramUserId = row.telegram_user_id;
  const name = row.name || "Друг";
  const language = row.language || "ru";

  const langLabel = { ru: "Russian", en: "English", uk: "Ukrainian", de: "German", fr: "French" }[language] || "Russian";

  const { data: snapshotRow } = await supabase
    .from("astro_snapshots")
    .select("snapshot_text")
    .eq("id", row.astro_snapshot_id)
    .maybeSingle();

  const astroText = snapshotRow?.snapshot_text || "[Натальная карта не найдена]";

  // В DeepSeek уходят полные данные натальной карты + «идеально отлаженный промпт» (ideally_tuned_system_v1)
  const variables = {
    name,
    birthdate: row.birthdate || "",
    birthplace: row.birthplace || "",
    birthtime: row.birthtime_unknown ? "не указано" : (row.birthtime || ""),
    language: langLabel,
    request: row.request || "",
    astro_snapshot: astroText,
  };

  const systemPrompt = await getRenderedPrompt(supabase, MAIN_PROMPT_NAME, variables);
  if (!systemPrompt) {
    await supabase.from("track_requests").update({
      status: "failed",
      error_message: "Промпт не найден в БД",
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    return;
  }

  const userMessage = "По данным выше выполни полный алгоритм: Этап 1 (анализ), при необходимости Этап 2, затем Этап 3 (песня). В конце обязательно укажи название песни в кавычках «» и блок ЛИРИКА с текстом песни и разметкой [verse 1], [chorus] и т.д., затем MUSIC PROMPT для Suno со [style: ...] на английском.";

  const llm = await chatCompletion(systemPrompt, userMessage, {});
  if (!llm.ok) {
    await supabase.from("track_requests").update({
      status: "failed",
      error_message: llm.error?.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    console.error("[Worker] DeepSeek:", llm.error);
    return;
  }

  const parsed = parseSongFromResponse(llm.text);
  if (!parsed || !parsed.lyrics) {
    await supabase.from("track_requests").update({
      status: "failed",
      error_message: "Не удалось извлечь лирику из ответа LLM",
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    return;
  }

  const updatePayload = {
    lyrics: parsed.lyrics,
    title: parsed.title,
    updated_at: new Date().toISOString(),
  };
  if (parsed.detailed_analysis != null) updatePayload.detailed_analysis = parsed.detailed_analysis;
  let { error: updateErr } = await supabase.from("track_requests").update(updatePayload).eq("id", id);
  if (updateErr && /column.*detailed_analysis|detailed_analysis.*column/i.test(updateErr.message || "")) {
    updateErr = null;
    await supabase.from("track_requests").update({
      lyrics: parsed.lyrics,
      title: parsed.title,
      updated_at: new Date().toISOString(),
    }).eq("id", id);
  }
  if (updateErr) {
    await supabase.from("track_requests").update({
      status: "failed",
      error_message: (updateErr.message || "Ошибка сохранения").slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    return;
  }

  const sunoParams = {
    prompt: parsed.lyrics,
    title: parsed.title,
    style: parsed.style,
  };
  if (process.env.SUNO_MODEL) sunoParams.model = process.env.SUNO_MODEL;
  if (process.env.SUNO_VOCAL_GENDER === "m" || process.env.SUNO_VOCAL_GENDER === "f") sunoParams.vocalGender = process.env.SUNO_VOCAL_GENDER;
  if (process.env.SUNO_NEGATIVE_TAGS) sunoParams.negativeTags = process.env.SUNO_NEGATIVE_TAGS;
  const sunoStart = await generateMusic(sunoParams);
  if (!sunoStart.ok) {
    await supabase.from("track_requests").update({
      status: "failed",
      error_message: sunoStart.error?.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    console.error("[Worker] Suno start:", sunoStart.error);
    return;
  }

  await supabase.from("track_requests").update({
    suno_task_id: sunoStart.taskId,
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  const sunoResult = await pollMusicResult(sunoStart.taskId);
  if (!sunoResult.ok) {
    await supabase.from("track_requests").update({
      status: "failed",
      error_message: sunoResult.error?.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", id);
    console.error("[Worker] Suno poll:", sunoResult.error);
    return;
  }

  await supabase.from("track_requests").update({
    audio_url: sunoResult.audioUrl,
    status: "completed",
    error_message: null,
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  const caption = getSongCaption(name, language);
  const send = await sendAudioToUser(telegramUserId, sunoResult.audioUrl, caption, parsed.title, name);
  const now = new Date().toISOString();
  if (!send.ok) {
    console.warn("[Worker] Telegram send:", send.error);
    await supabase.from("track_requests").update({
      generation_status: "delivery_failed",
      delivery_status: "failed",
      error_message: `Доставка не удалась: ${send.error}`.slice(0, 500),
      updated_at: now,
    }).eq("id", id);
  } else {
    console.log("[Worker] Отправлено пользователю", telegramUserId, "заявка", id);
    await supabase.from("track_requests").update({
      generation_status: "completed",
      delivery_status: "sent",
      delivered_at: now,
      error_message: null,
      updated_at: now,
    }).eq("id", id);
  }
}

/** Ставим статус processing, выполняем processOneRequest, при ошибке — failed */
async function runOneRow(row) {
  const { data: claimed } = await supabase.from("track_requests").update({
    status: "processing",
    updated_at: new Date().toISOString(),
  }).eq("id", row.id).eq("status", "pending").select("id");
  if (!claimed?.length) {
    console.log("[Worker] Заявка", row.id, "уже захвачена другим воркером — пропускаем");
    return;
  }
  console.log("[Worker] Обрабатываю заявку", row.id);
  try {
    await processOneRequest({ ...row, status: "processing" });
  } catch (e) {
    console.error("[Worker] Необработанная ошибка:", e);
    await supabase.from("track_requests").update({
      status: "failed",
      error_message: (e?.message || String(e)).slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
  }
}

/** Один проход: одна заявка pending с уже готовым астро-снапшотом */
async function runOnce() {
  if (!supabase) {
    console.error("[Worker] Нет Supabase");
    return;
  }
  // Не трогаем заявки, которые уже обрабатывает workerSoundKey (ваш промпт из кода)
  const { data: rows, error } = await supabase
    .from("track_requests")
    .select("id, telegram_user_id, name, birthdate, birthplace, birthtime, birthtime_unknown, request, language, astro_snapshot_id")
    .eq("status", "pending")
    .or("generation_status.is.null,generation_status.eq.pending")
    .not("astro_snapshot_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) {
    console.error("[Worker] Supabase:", error.message);
    return;
  }
  if (!rows?.length) {
    console.log("[Worker] Нет подходящих заявок (pending + astro). Дождись новой заявки из Mini App или проверь статусы в Supabase.");
    return;
  }
  await runOneRow(rows[0]);
}

/**
 * Автономный проход (docs/ALGORITHM.md): одна заявка pending, при необходимости астро, затем DeepSeek → Suno → отправка.
 */
async function runOnceWithAstro() {
  if (!supabase) {
    console.error("[Worker] Нет Supabase");
    return;
  }
  // Только оплаченные заявки — unpaid не должны получать треки бесплатно
  const allowedPayment = ["paid", "gift_used", "subscription_active"];
  const { data: rows, error } = await supabase
    .from("track_requests")
    .select("id, telegram_user_id, name, birthdate, birthplace, birthtime, birthtime_unknown, request, language, astro_snapshot_id")
    .eq("status", "pending")
    .or("generation_status.is.null,generation_status.eq.pending")
    .in("payment_status", allowedPayment)
    .order("paid_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) {
    console.error("[Worker] Supabase:", error.message);
    return;
  }
  if (!rows?.length) {
    console.log("[Worker] Нет заявок pending (без processing). Новые заявки обрабатывает workerSoundKey в боте.");
    return;
  }
  let row = rows[0];
  if (!row.astro_snapshot_id) {
    const { computeAndSaveAstroSnapshot } = await import("./workerAstro.js");
    const astroResult = await computeAndSaveAstroSnapshot(supabase, row.id);
    if (!astroResult.ok) {
      await supabase.from("track_requests").update({
        status: "failed",
        error_message: (astroResult.error || "Ошибка расчёта карты").slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);
      console.error("[Worker] Астро:", astroResult.error);
      return;
    }
    row = { ...row, astro_snapshot_id: astroResult.astro_snapshot_id };
    console.log("[Worker] Натальная карта посчитана для заявки", row.id);
  }
  await runOneRow(row);
}

const isMain = process.argv[1]?.endsWith("workerGenerate.js");
if (isMain) {
  runOnce()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[Worker] Ошибка:", e);
      process.exit(1);
    });
}

export { processOneRequest, runOnce, runOnceWithAstro };
