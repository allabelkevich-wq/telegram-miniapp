/**
 * Воркер генерации звукового ключа
 * Запускается фоново при новой заявке
 * ИСПРАВЛЕННАЯ ВЕРСИЯ: интегрирована с существующей архитектурой
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from '@supabase/supabase-js';
import { computeAndSaveAstroSnapshot } from "./workerAstro.js";
import { chatCompletion } from "./deepseek.js";
import { generateMusic, pollMusicResult } from "./suno.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// КОНФИГУРАЦИЯ
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
// Примечание: DEEPSEEK_API_KEY и SUNO_API_KEY используются через модули deepseek.js и suno.js

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("[workerSoundKey] SUPABASE_URL и SUPABASE_SERVICE_KEY обязательны");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================================
// УСИЛЕННЫЙ СИСТЕМНЫЙ ПРОМПТ (загрузка из файла)
// ============================================================================

let SYSTEM_PROMPT;
try {
  SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "enhanced_system.txt"), "utf8");
} catch (e) {
  console.error("[workerSoundKey] Не удалось загрузить prompts/enhanced_system.txt:", e.message);
  process.exit(1);
}

// ============================================================================
// ОЧИСТКА ТЕКСТА ПЕСНИ ОТ ЗАПРЕЩЁННЫХ ТЕРМИНОВ
// ============================================================================

const FORBIDDEN_TERMS = [
  "асцендент", "десцендент", "мидхейвен", "имум кайли", "солнце", "луна",
  "меркурий", "венера", "марс", "юпитер", "сатурн", "уран", "нептун", "плутон",
  "северный узел", "южный узел", "лилий", "хирон", "раху", "кету", "дом",
  "куспид", "овен", "телец", "близнецы", "рак", "лев", "дева", "весы",
  "скорпион", "стрелец", "козерог", "водолей", "рыбы", "стихия", "модальность",
  "карма", "кармический", "натальная карта", "гороскоп", "аспект", "конъюнкция",
  "квадратура", "тригон", "оппозиция", "секстиль", "квинконс", "ретроградный",
  "астрологический", "знак зодиака", "директный", "стационарный",
];

function sanitizeSongText(text) {
  if (!text || typeof text !== "string") return text;
  let cleaned = text.toLowerCase();
  FORBIDDEN_TERMS.forEach((term) => {
    cleaned = cleaned.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "твой внутренний свет");
  });
  return cleaned;
}

// ============================================================================
// ПАРСИНГ ОТВЕТА LLM
// ============================================================================

function parseResponse(text) {
  if (!text || typeof text !== "string") return null;
  
  let detailed_analysis = "";
  let title = "";
  let lyrics = "";
  let style = "ambient cinematic";
  
  // Анализ - всё до "ПЕСНЯ ДЛЯ" или "ЭТАП 3"
  const analysisEnd = text.search(/\n\s*ПЕСНЯ ДЛЯ\s|ЭТАП 3|ЛИРИКА\s*:\s*/i);
  if (analysisEnd > 0) {
    detailed_analysis = text.slice(0, analysisEnd).trim();
  }
  if (detailed_analysis.length > 50000) detailed_analysis = detailed_analysis.slice(0, 50000);
  
  // Название из кавычек
  const titleMatch = text.match(/«([^»]+)»/);
  if (titleMatch) title = titleMatch[1].trim();
  
  // Стиль из [style: ...]
  const styleMatch = text.match(/\[style:\s*([^\]]+)\]/i);
  if (styleMatch) style = styleMatch[1].trim().slice(0, 500);
  
  // Лирика - всё от [intro] или [verse 1] до MUSIC PROMPT или конца
  const lyricsStart = text.search(/\[(?:intro|verse\s*1|chorus|bridge)\]/i);
  if (lyricsStart >= 0) {
    const afterStart = text.slice(lyricsStart);
    const endMark = afterStart.search(/\n\s*MUSIC PROMPT|КЛЮЧЕВЫЕ ПРИНЦИПЫ|\[style:\s*[^\]]+\]\s*\[vocal:/i);
    lyrics = (endMark >= 0 ? afterStart.slice(0, endMark) : afterStart).trim();
  }
  
  if (!title && lyrics) title = "Sound Key";
  if (!lyrics) return null;
  
  return {
    detailed_analysis: detailed_analysis || null,
    title: title.slice(0, 100),
    lyrics: lyrics.slice(0, 5000),
    style: style.slice(0, 1000),
  };
}

// ============================================================================
// ОТПРАВКА АУДИО ПОЛЬЗОВАТЕЛЮ
// ============================================================================

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

// ============================================================================
// ОСНОВНАЯ ФУНКЦИЯ ГЕНЕРАЦИИ
// ============================================================================

export async function generateSoundKey(requestId) {
  try {
    console.log(`[Воркер] Начинаю генерацию для заявки ${requestId}`);
    
    // Шаг 1: Получить данные заявки из БД
    const { data: request, error: reqError } = await supabase
      .from('track_requests')
      .select('*')
      .eq('id', requestId)
      .single();
    
    if (reqError || !request) {
      throw new Error(`Заявка ${requestId} не найдена: ${reqError?.message}`);
    }
    
    // Шаг 2: Проверяем/создаём натальную карту (КРИТИЧНО!)
    if (!request.astro_snapshot_id) {
      console.log(`[Воркер] Расчёт натальной карты для заявки ${requestId}`);
      const astroResult = await computeAndSaveAstroSnapshot(supabase, requestId);
      if (!astroResult.ok) {
        throw new Error(`Ошибка расчёта натальной карты: ${astroResult.error}`);
      }
      // Обновляем заявку с astro_snapshot_id
      await supabase
        .from('track_requests')
        .update({ astro_snapshot_id: astroResult.astro_snapshot_id })
        .eq('id', requestId);
      
      // Перезагружаем заявку
      const { data: updated } = await supabase
        .from('track_requests')
        .select('*')
        .eq('id', requestId)
        .single();
      if (updated) Object.assign(request, updated);
    }
    
    // Шаг 3: Получаем натальную карту
    const { data: snapshotRow } = await supabase
      .from("astro_snapshots")
      .select("snapshot_text")
      .eq("id", request.astro_snapshot_id)
      .maybeSingle();
    
    const astroText = snapshotRow?.snapshot_text || "[Натальная карта не найдена]";
    
    // Шаг 4: Формируем запрос для DeepSeek
    const langLabel = { ru: "Russian", en: "English", uk: "Ukrainian" }[request.language || "ru"] || "Russian";
    const userRequest = `ЭТО ${request.name} и её/его запрос: "${request.request || 'создать песню'}"
Дата рождения: ${request.birthdate}
Место рождения: ${request.birthplace}
Время рождения: ${request.birthtime_unknown ? 'неизвестно' : request.birthtime}
Пол: ${request.gender}
Язык песни и расшифровки: ${langLabel}

Натальная карта:
${astroText}`;
    
    // Шаг 5: Отправить в DeepSeek (используем существующий модуль)
    console.log(`[Воркер] Отправляю запрос в DeepSeek для ${request.name}`);
    
    const llm = await chatCompletion(SYSTEM_PROMPT, userRequest, { 
      max_tokens: 4000,
      temperature: 0.85 
    });
    
    if (!llm.ok) {
      throw new Error(`DeepSeek ошибка: ${llm.error}`);
    }
    
    const fullResponse = llm.text;
    console.log(`[Воркер] Получен анализ от DeepSeek (длина: ${fullResponse.length})`);
    
    // Шаг 6: Парсим ответ
    const parsed = parseResponse(fullResponse);
    if (!parsed || !parsed.lyrics) {
      throw new Error('Не удалось извлечь лирику из ответа LLM');
    }
    let lyricsForSuno = sanitizeSongText(parsed.lyrics);
    const lineCount = lyricsForSuno.split(/\n/).filter((l) => l.trim()).length;
    if (lineCount < 32) {
      throw new Error(`Песня слишком короткая (${lineCount} строк, нужно минимум 32)`);
    }
    
    // Шаг 7: Сохраняем анализ и лирику (в БД — очищенная версия)
    await supabase
      .from('track_requests')
      .update({
        lyrics: lyricsForSuno,
        title: parsed.title,
        detailed_analysis: parsed.detailed_analysis,
        status: 'processing',
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId);
    
    // Шаг 8: Отправить в SUNO (очищенная лирика, минимум 32 строки)
    console.log(`[Воркер] Отправляю в SUNO для ${request.name}`);
    
    const sunoParams = {
      prompt: lyricsForSuno,
      title: parsed.title,
      style: parsed.style,
    };
    if (process.env.SUNO_MODEL) sunoParams.model = process.env.SUNO_MODEL;
    if (process.env.SUNO_VOCAL_GENDER === "m" || process.env.SUNO_VOCAL_GENDER === "f") {
      sunoParams.vocalGender = process.env.SUNO_VOCAL_GENDER;
    }
    
    const sunoStart = await generateMusic(sunoParams);
    if (!sunoStart.ok) {
      throw new Error(`Suno start ошибка: ${sunoStart.error}`);
    }
    
    console.log(`[Воркер] Задача в SUNO создана, taskId: ${sunoStart.taskId}`);
    
    await supabase
      .from('track_requests')
      .update({ suno_task_id: sunoStart.taskId })
      .eq('id', requestId);
    
    // Шаг 9: Ожидание завершения генерации (используем существующий модуль)
    const sunoResult = await pollMusicResult(sunoStart.taskId);
    if (!sunoResult.ok) {
      throw new Error(`Suno poll ошибка: ${sunoResult.error}`);
    }
    
    const audioUrl = sunoResult.audioUrl;
    console.log(`[Воркер] Музыка готова: ${audioUrl}`);
    
    // Шаг 10: Обновить статус заявки и сохранить поля песни в БД
    await supabase
      .from('track_requests')
      .update({
        status: 'completed',
        audio_url: audioUrl,
        detailed_analysis: fullResponse,
        lyrics: lyricsForSuno,
        title: parsed.title,
        language: 'ru',
        generation_status: 'completed',
        error_message: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId);
    
    // Шаг 11: Отправить аудио пользователю
    const caption = `🗝️ ${request.name}, твой звуковой ключ готов!\n\nЭто твоё персональное звуковое лекарство. Слушай каждое утро в тишине с закрытыми глазами.\n\nСлушай сердцем ❤️\n— YupSoul`;
    const send = await sendAudioToUser(request.telegram_user_id, audioUrl, caption);
    
    if (!send.ok) {
      console.warn(`[Воркер] Ошибка отправки аудио: ${send.error}`);
      // Отправляем резервное сообщение
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: request.telegram_user_id,
            text: `🗝️ ${request.name}, твой звуковой ключ готов!\n\nАудиофайл временно недоступен для отправки. Напиши в поддержку — я пришлю его вручную в течение часа.\n\nСпасибо за терпение! ❤️`
          })
        });
      } catch (e) {
        console.error('[Воркер] Не удалось отправить резервное сообщение:', e.message);
      }
    } else {
      console.log(`[Воркер] ✅ Заявка ${requestId} завершена для ${request.name}`);
    }
    
    return { ok: true, audioUrl };
    
  } catch (error) {
    console.error(`[Воркер] Ошибка генерации для заявки ${requestId}:`, error.message);
    
    // Обновляем статус на failed
    await supabase
      .from('track_requests')
      .update({
        status: 'failed',
        error_message: error.message?.slice(0, 500),
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId)
      .catch(() => {});
    
    // Уведомить админа об ошибке
    if (process.env.ADMIN_TELEGRAM_IDS && BOT_TOKEN) {
      const adminIds = process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => id.trim());
      for (const adminId of adminIds) {
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: adminId,
              text: `❌ Ошибка генерации для заявки ${requestId}\n\n${error.message?.substring(0, 300)}`
            })
          });
        } catch (e) {
          console.error('[Воркер] Не удалось уведомить админа:', e.message);
        }
      }
    }
    
    return { ok: false, error: error.message };
  }
}

// ============================================================================
// ТРИГГЕР ЗАПУСКА (для тестирования)
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2]) {
  const requestId = process.argv[2];
  console.log(`Запуск воркера для заявки ${requestId}`);
  generateSoundKey(requestId).then(result => {
    console.log('Результат:', result);
    process.exit(result.ok ? 0 : 1);
  }).catch(err => {
    console.error('Ошибка:', err);
    process.exit(1);
  });
}
