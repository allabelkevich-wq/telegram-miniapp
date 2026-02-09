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
 * 1) detailed_analysis — подробный анализ карты (выдаётся только после оплаты)
 * 2) style — один или два стиля для Suno
 * 3) lyrics — текст песни
 * 4) title — название песни
 */
function parseSongFromResponse(text) {
  if (!text || typeof text !== "string") return null;
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

/** Отправка аудио пользователю в Telegram по URL */
async function sendAudioToUser(telegramUserId, audioUrl, caption) {
  if (!BOT_TOKEN || !telegramUserId) return { ok: false, error: "Нет BOT_TOKEN или chat_id" };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`;
  const body = new URLSearchParams({
    chat_id: String(telegramUserId),
    audio: audioUrl,
    caption: caption || "Твой персональный звуковой ключ готов.",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) return { ok: false, error: data.description || "Telegram API error" };
  return { ok: true };
}

/** Обработка одной заявки: LLM → Suno → отправка */
async function processOneRequest(row) {
  const id = row.id;
  const telegramUserId = row.telegram_user_id;
  const name = row.name || "Друг";
  const language = row.language || "ru";

  const langLabel = { ru: "Russian", en: "English", uk: "Ukrainian" }[language] || "Russian";

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

  const llm = await chatCompletion(systemPrompt, userMessage, { max_tokens: 8192 });
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

  const caption = `${name}, твой персональный звуковой ключ готов. Слушай в тишине — это твой артефакт силы для игры жизни. ✨`;
  const send = await sendAudioToUser(telegramUserId, sunoResult.audioUrl, caption);
  if (!send.ok) {
    console.warn("[Worker] Telegram send:", send.error);
  } else {
    console.log("[Worker] Отправлено пользователю", telegramUserId, "заявка", id);
  }
}

/** Ставим статус processing, выполняем processOneRequest, при ошибке — failed */
async function runOneRow(row) {
  await supabase.from("track_requests").update({
    status: "processing",
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
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
  const { data: rows, error } = await supabase
    .from("track_requests")
    .select("id, telegram_user_id, name, birthdate, birthplace, birthtime, birthtime_unknown, request, language, astro_snapshot_id")
    .eq("status", "pending")
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
  const { data: rows, error } = await supabase
    .from("track_requests")
    .select("id, telegram_user_id, name, birthdate, birthplace, birthtime, birthtime_unknown, request, language, astro_snapshot_id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) {
    console.error("[Worker] Supabase:", error.message);
    return;
  }
  if (!rows?.length) {
    console.log("[Worker] Нет заявок pending. Отправь заявку из Mini App — при следующем запуске воркер её обработает.");
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
