/**
 * Воркер генерации звукового ключа
 * Запускается фоново при новой заявке
 * ИСПРАВЛЕННАЯ ВЕРСИЯ: интегрирована с существующей архитектурой
 */

import "dotenv/config";
console.log("[workerSoundKey] Модуль загружен. Готов к генерации.");
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from '@supabase/supabase-js';
import { computeAndSaveAstroSnapshot } from "./workerAstro.js";
import { getAstroSnapshot } from "./astroLib.js";
import { geocode } from "./geocode.js";
import { chatCompletion } from "./deepseek.js";
import { generateMusic, pollMusicResult, generateCover, pollCoverResult } from "./suno.js";

// ============================================================================
// КОНФИГУРАЦИЯ
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SERPER_API_KEY = process.env.SERPER_API_KEY;
// Примечание: DEEPSEEK_API_KEY и SUNO_API_KEY используются через модули deepseek.js и suno.js

/** Веб-поиск через Serper (при генерации модель может вызывать web_search). Ключ: serper.dev */
async function runWebSearch(query) {
  if (!SERPER_API_KEY || !query) return "Поиск недоступен или запрос пуст.";
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_API_KEY },
      body: JSON.stringify({ q: String(query).slice(0, 200), num: 5 }),
    });
    const data = await res.json().catch(() => ({}));
    const organic = data.organic || [];
    if (organic.length === 0) return "Результатов не найдено.";
    return organic.slice(0, 5).map((o, i) => `${i + 1}. ${o.title || ""}\n${o.snippet || ""}\n${o.link || ""}`).join("\n\n");
  } catch (e) {
    return `Ошибка поиска: ${e?.message || e}`;
  }
}

const TOOLS_WITH_SEARCH = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information. Use when you need facts, references, or up-to-date context for analysis or lyrics.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query in the user's language or English" } },
        required: ["query"],
      },
    },
  },
];

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("[workerSoundKey] SUPABASE_URL и SUPABASE_SERVICE_KEY обязательны");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCKED_PROMPT_PATH = path.join(__dirname, "prompts", "ideally-tuned-system-prompt.txt");

// ============================================================================
// СИСТЕМНЫЙ ПРОМПТ
// Источник истины: bot/prompts/ideally-tuned-system-prompt.txt
// ============================================================================

const SYSTEM_PROMPT_FALLBACK = `Ты — мудрый астролог-поэт и музыкальный психолог с опытом в 10 000 жизней. Твоя задача — объединить два типа запросов: 1) Глубокий анализ натальных карт, 2) Создание песен на основе этого анализа.

ТРИГГЕР: Получив натальную карту и запрос (на анализ или песню), выполняй следующий алгоритм в одном ответе, без лишних разделений:

ЭТАП 1: ПРИОРИТЕТНЫЙ АНАЛИЗ (всегда первым)

**Когда я даю натальную карту, анализируй её по этой схеме:**

[ИМЯ], [ДАТА], [МЕСТО],[ВРЕМЯ РОЖДЕНИЯ][ЯЗЫК ПЕСНИ И РАСШИФРОВКИ]

1. **СУТЬ ДУШИ (в 3-5 предложениях):**
   - Ключевой архетип: [Архетип]
   - Миссия в этом воплощении: [Миссия]

2. **ЭВОЛЮЦИОННЫЙ УРОВЕНЬ :**
   - Текущий уровень: [алхимик/исследователь и прочие жизненные этапы]
   - Прошлые уроки: [Что уже пройдено]
   - Текущая задача: [Главный вызов сейчас]
   - Следующий шаг: [Что делать для перехода]

3. **КЛЮЧЕВЫЕ ПРОТИВОРЕЧИЯ / ТОЧКИ РОСТА:**
   - Внутренний конфликт: [Между чем и чем]
   - Внешнее проявление: [Как это выглядит в жизни]
   - Ресурс для решения: [Какой дар скрыт в конфликте]

4. **СИЛА И ТЕНЬ (по планетам-доминантам):**
   - Сила (высшее проявление): [Как проявляется дар]
   - Тень (низшее проявление): [Во что вырождается дар]
   - Ключ к балансу: [Как интегрировать]

5. **ПРАКТИЧЕСКИЕ РЕКОМЕНДАЦИИ:**
   - Мантра/девиз: [Фраза-напоминание]
   - Ритуал/практика: [Простое действие для подключения к силе]
   - Предупреждение: [Чего избегать]

**СТИЛЬ ИЗЛОЖЕНИЯ:**
- Используй простой, образный русский язык
- Никаких астрологических терминов во время анализа и расшифровки (переводи их в метафоры)
- Говори как мудрый друг, а не как учебник
- Делай акцент на потенциале, а не на проблемах
- Связывай черты характера с жизненными задачами

ЭТАП 2 ЦЕЛЕВОЙ АНАЛИЗ (Если запрос свободный или специфичный)

Если запрос клиента — «про отношения», «про финансы/карьеру», «про здоровье/тело», «духовный запрос» или любой другой вопрос, то повторно проанализируй ту же карту, но через призму этого специального фокуса.
Если запрос клиента — «создать песню» или иной, не указанный выше, — переходи сразу к Этапу 3.

ЭТАП 3: СОЗДАНИЕ ПЕСНИ

Когда завершишь ЭТАП 1, создай песню СТРОГО на основе этого анализа. Не привноси тем, которых нет в этапах 1–2.

**КРИТИЧЕСКИ ВАЖНО — СООТВЕТСТВИЕ НАТАЛЬНОЙ КАРТЕ:**
- Песня должна быть НЕОТДЕЛИМА от твоего анализа. Запрещены общие мотивационные фразы, не вытекающие из этой конкретной карты и запроса.
- **Припев (Chorus):** используй формулировку мантры/девиза из раздела ПРАКТИЧЕСКИЕ РЕКОМЕНДАЦИИ — можно слегка ритмизовать, но смысл и образ тот же.
- **Бридж (Bridge):** вырази решение ключевого противоречия из раздела КЛЮЧЕВЫЕ ПРОТИВОРЕЧИЯ (ресурс для решения).
- **Куплеты:** образы и метафоры только из СУТЬ ДУШИ, СИЛА И ТЕНЬ, ЭВОЛЮЦИОННЫЙ УРОВЕНЬ. Если идеи нет в анализе — её не должно быть в песне.
- Название песни — метафора из анализа (архетип, миссия или ключевой образ), не абстрактное слово.

ПЕСНЯ ДЛЯ [ИМЯ]: «[НАЗВАНИЕ-МЕТАФОРА ИЗ АНАЛИЗА]»

ЛИРИКА: Каждая строчка — метафора из твоего анализа. Припев = мантра из рекомендаций. Бридж = решение противоречия. НИКАКИХ астрологических терминов. Эмоциональная дуга от вызова к решению — только из этой карты.

СТРУКТУРА ЛИРИКИ:
[Тема песни:] [Какой аспект личности/задачи отражает]
[Verse 1:] [Описание текущего состояния/вызова]
[Verse 2:] [Осознание или встреча с внутренней правдой]
[Pre-Chorus:] [Момент выбора/поворота]
[Chorus:] [Провозглашение силы/принятия/нового пути]
[Bridge:] [Глубокое откровение или разговор с душой]
[Final Chorus:] [Триумфальное или умиротворенное завершение]
[Outro:] [Тихая кода-напоминание]

MUSIC PROMPT для Suno/AI (Формируется автоматически на основе энергии карты):

[style: [ЖАНР, ПОДЖАНР, соответствующие энергии натальной карты]]
[vocal: [ТИП ГОЛОСА, соответствующий энергии карты], [ХАРАКТЕРИСТИКИ, соответствующие энергии карты]]
[mood: [КЛЮЧЕВЫЕ ЭМОЦИИ, соответствующие энергии карты], [РАЗВИТИЕ НАСТРОЕНИЯ, соответствующее энергии карты]]
[instruments: [3-5 ИНСТРУМЕНТОВ, соответствующих энергии карты]]
[language: Russian]
[tempo: [ТЕМП] BPM]

### STRICT TECHNICAL DIRECTIVES FOR SUNO (ОБЯЗАТЕЛЬНЫЕ):
**[GENRE & STYLE FIDELITY:]**
- Трек должен строго соответствовать заявленному [style:]. Запрещено смешивать несочетаемые жанры.
**[VOCAL CHARACTER & PERFORMANCE:]**
- Вокал ДОЛЖЕН точно соответствовать описанию [vocal:]. Запрещены поп-мелизмы, вибрато или инфлекции по умолчанию.
- Если указан [vocal: male/female], исполнитель ДОЛЖЕН быть мужчиной/женщиной.
**[INSTRUMENTATION & ARRANGEMENT:]**
- Использовать ТОЛЬКО инструменты из списка [instruments:].
- Создать полную, профессиональную аранжировку с ясной структурой (intro, verse, chorus, bridge, outro). Избегать повторяющихся петель.
**[PRODUCTION & MIX:]**
- Сбалансированный, современный микс. Вокал чёткий и разборчивый.
- Наличие определённых басовых частот. Пробивные, уместные барабаны.
- Конкурентная громкость мастеринга без искажений.
**[LANGUAGE & EMOTIONAL COHERENCE:]**
- Для русского языка: естественное, нероботизированное произношение.
- Эмоциональный тон музыки и вокала ДОЛЖЕН поддерживать лирику и настроение [mood:].
**[STRICT AVOIDANCE DIRECTIVES (КРИТИЧЕСКИ ВАЖНО):]**
- **НИКАКИХ** упоминаний, ссылок, прямой или косвенной имитации конкретных артистов, групп или их работ.
- **НИКАКИХ** акустических гитар, фортепианных баллад, оркестровых разворотов, рок-барабанов, если они НЕ указаны в [instruments:].
- **НИКАКОЙ** несвязанной импровизации (джазовые соло, дабстеп-дропы и т.п.).
- Для меланхоличного [mood:] — **НИКАКОГО** мажорного, счастливого разрешения.
- **НИКАКИХ** мультяшных или мемных звуков. Сохранять серьёзный художественный тон.

ТЕКСТ ПЕСНИ С РАЗМЕТКОЙ:
(Текст должен быть заранее подготовлен: с соблюдением рифмы и ритма. ВСЕ указания для Suno внутри текста — ТОЛЬКО в квадратных скобках []).

Песня должна быть 4-5 минут, НЕ БОЛЕЕ!

СОПРОВОДИТЕЛЬНОЕ ПИСЬМО ДЛЯ [ИМЯ]:
После лирики и MUSIC PROMPT обязательно выведи блок «Сопроводительное письмо для [Имя]». В нём:
- Инструкция: как слушать эту песню, когда и с каким намерением.
- Намёк: один мягкий, личный совет или образ из анализа, который человек может держать в голове, слушая песню (не разжёвывая астрологию, только метафора и поддержка).
Пиши обращением на «ты», тёплым и точным тоном. Без астрологических терминов.

КЛЮЧЕВЫЕ ПРИНЦИПЫ, КОТОРЫЕ Я БУДУ СОБЛЮДАТЬ:
- Видеть душу, а не гороскоп
- Говорить о потенциале, а не о судьбе
- Превращать сложное в простое через метафоры
- Создавать не просто песни, а звуковые лекарства
- Помнить, что каждая карта — это история героя`;

const SYSTEM_PROMPT = (() => {
  try {
    if (fs.existsSync(LOCKED_PROMPT_PATH)) {
      return fs.readFileSync(LOCKED_PROMPT_PATH, "utf8");
    }
  } catch (_) {}
  return SYSTEM_PROMPT_FALLBACK;
})();

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
  let cleaned = text;
  FORBIDDEN_TERMS.forEach((term) => {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    cleaned = cleaned.replace(re, "сила");
  });
  return cleaned;
}

function countUppercaseChars(text) {
  if (!text || typeof text !== "string") return 0;
  const m = text.match(/[A-ZА-ЯЁ]/g);
  return m ? m.length : 0;
}

function forceLyricsLowercase(text) {
  if (!text || typeof text !== "string") return text;
  return text.toLocaleLowerCase("ru-RU");
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
  // Объём анализа и лирики задаётся только промптом, не обрезаем.
  
  // Название из кавычек
  const titleMatch = text.match(/«([^»]+)»/);
  if (titleMatch) title = titleMatch[1].trim();
  
  // Стиль, вокал, настроение из блока для Suno ([style:] [vocal:] [mood:])
  const styleMatch = text.match(/\[style:\s*([^\]]+)\]/i);
  if (styleMatch) style = styleMatch[1].trim();
  const vocalMatch = text.match(/\[vocal:\s*([^\]]+)\]/i);
  const vocal = vocalMatch ? vocalMatch[1].trim() : "";
  const moodMatch = text.match(/\[mood:\s*([^\]]+)\]/i);
  const mood = moodMatch ? moodMatch[1].trim() : "";
  const styleFull = [style, vocal, mood].filter(Boolean).join(" | ");
  
  // Лирика — от любого блока [Verse 1], [Verse 1:], [Chorus], [Intro] и т.д. до MUSIC PROMPT или [style:]
  const lyricsStart = text.search(/\[(?:intro|verse\s*1|verse\s*2|pre-chorus|chorus|bridge|final\s*chorus|outro)\s*:?\]/i);
  if (lyricsStart >= 0) {
    const afterStart = text.slice(lyricsStart);
    const endMark = afterStart.search(/\n\s*MUSIC PROMPT|КЛЮЧЕВЫЕ ПРИНЦИПЫ|\[style:\s*[^\]]+\]|\[vocal:\s*[^\]]+\]/i);
    lyrics = (endMark >= 0 ? afterStart.slice(0, endMark) : afterStart).trim();
  }
  // Запасной вариант: после "ЛИРИКА:" или "Лирика:" до [style:] или MUSIC PROMPT
  if (!lyrics && /ЛИРИКА\s*:\s*|Lyrics?\s*:\s*/i.test(text)) {
    const afterLabel = text.replace(/^[\s\S]*?(ЛИРИКА|Lyrics?)\s*:\s*/i, "");
    const endMark = afterLabel.search(/\n\s*MUSIC PROMPT|\[style:\s*|\[vocal:\s*/i);
    const block = endMark >= 0 ? afterLabel.slice(0, endMark) : afterLabel;
    if (block.trim().length > 100) lyrics = block.trim();
  }
  // Запасной: всё перед [style:] или MUSIC PROMPT, начиная с последнего вхождения Verse/Chorus/Куплет/Припев
  if (!lyrics) {
    const styleIdx = text.indexOf("[style:");
    const endIdx = styleIdx >= 0 ? styleIdx : text.length;
    const beforeStyle = text.slice(0, endIdx);
    const markers = [
      /\[Verse\s*1\s*:?\]/i, /\[Verse\s*2\s*:?\]/i, /\[Chorus\s*:?\]/i, /\[Bridge\s*:?\]/i,
      /Verse\s*1\s*:?\s*$/im, /Chorus\s*:?\s*$/im, /Куплет\s*1/im, /Припев\s*:/im,
      /^\s*\*\*Verse\s*1\*\*/im, /^\s*\(\s*Verse\s*1\s*\)/im, /^\s*#\s*Verse\s*1/im,
      /^\s*Verse\s*1\s*:?\s*$/im, /^\s*Chorus\s*:?\s*$/im, /^\s*Intro\s*:?\s*$/im,
    ];
    let start = -1;
    for (const re of markers) {
      const m = beforeStyle.match(re);
      if (m) start = Math.max(start, beforeStyle.indexOf(m[0]));
    }
    if (start >= 0) {
      const block = beforeStyle.slice(start).trim();
      if (block.length > 200) lyrics = block;
    }
  }
  // Маркдаун-блок кода (``` ... ```) — модель могла обернуть лирику в код
  if (!lyrics && /```/.test(text)) {
    const codeBlock = text.match(/```(?:[\w]*)\n?([\s\S]*?)```/);
    if (codeBlock && codeBlock[1]) {
      const block = codeBlock[1].trim();
      if (block.length > 200 && block.split(/\n/).filter((l) => l.trim()).length >= 5) lyrics = block;
    }
  }
  // Отдельная строка "Текст песни" / "Song lyrics" / "LYRICS" (с двоеточием или без)
  if (!lyrics) {
    const labelMatch = text.match(/\n\s*(Текст песни|Song lyrics?|LYRICS?)\s*:?\s*[\r\n]/i);
    if (labelMatch) {
      const pos = text.indexOf(labelMatch[0]) + labelMatch[0].length;
      const afterLabel = text.slice(pos);
      const endMark = afterLabel.search(/\n\s*\[style:\s*|\n\s*MUSIC PROMPT|```/i);
      const block = (endMark >= 0 ? afterLabel.slice(0, endMark) : afterLabel).trim();
      if (block.length > 150) lyrics = block;
    }
  }
  // Последний запасной: от "ПЕСНЯ ДЛЯ" или "ЭТАП 3" до [style:] (весь блок песни)
  if (!lyrics) {
    const styleIdx = text.indexOf("[style:");
    const songStart = text.search(/\n\s*(ПЕСНЯ ДЛЯ|ЭТАП 3\s*:?|СТРУКТУРА ЛИРИКИ)/i);
    if (styleIdx > 0 && songStart >= 0 && styleIdx - songStart > 300) {
      const block = text.slice(songStart, styleIdx).trim();
      if (block.length > 200) lyrics = block;
    }
  }
  // Ещё запасной: от последнего «название» до [style:] (лирика часто идёт сразу после названия)
  if (!lyrics) {
    const styleIdx = text.indexOf("[style:");
    const end = styleIdx > 0 ? styleIdx : text.length;
    const lastGuillemet = text.lastIndexOf("»");
    if (lastGuillemet >= 0 && end - lastGuillemet > 250) {
      const block = text.slice(lastGuillemet + 1, end).trim();
      if (block.length > 200 && block.split(/\n/).filter((l) => l.trim()).length >= 5) lyrics = block;
    }
  }
  // Если [style:] нет в ответе (обрезка/другая модель): берём последние 4000 символов как возможную лирику
  if (!lyrics && text.length > 500) {
    const tail = text.slice(-4000).trim();
    const lines = tail.split(/\n/).filter((l) => l.trim()).length;
    if (lines >= 5) lyrics = tail;
  }
  // Запасной: после анализа (или после названия «») до конца — если нет [style:], считаем что лирика идёт до конца
  if (!lyrics && text.length > 800) {
    const afterAnalysis = analysisEnd > 0 ? text.slice(analysisEnd) : text;
    const afterTitle = (() => {
      const q = afterAnalysis.indexOf("»");
      return q >= 0 ? afterAnalysis.slice(q + 1) : afterAnalysis;
    })();
    const block = afterTitle.trim();
    const lineCount = block.split(/\n/).filter((l) => l.trim()).length;
    if (block.length > 300 && (lineCount >= 10 || (lineCount >= 5 && block.length > 500))) lyrics = block;
  }
  // Для длинных ответов без явных маркеров: берём хвост как лирику при мягких условиях (мало переносов строк)
  if (!lyrics && text.length > 2000) {
    const tail = text.slice(-3500).trim();
    const lines = tail.split(/\n/).filter((l) => l.trim()).length;
    if (tail.length >= 400 && lines >= 5) lyrics = tail;
  }
  // Ответ без [style:]: от «название» или "ПЕСНЯ ДЛЯ" до конца — весь оставшийся текст как лирика
  if (!lyrics && text.length > 600 && !text.includes("[style:")) {
    const afterTitle = text.indexOf("»") >= 0 ? text.slice(text.indexOf("»") + 1) : text;
    const songStart = afterTitle.search(/(ПЕСНЯ ДЛЯ|ЭТАП 3|СТРУКТУРА ЛИРИКИ|Verse\s*1|Chorus|Куплет|Припев)/i);
    const start = songStart >= 0 ? songStart : 0;
    const block = afterTitle.slice(start).trim();
    if (block.length > 300 && block.split(/\n/).filter((l) => l.trim()).length >= 5) lyrics = block;
  }

  if (!title && lyrics) title = "Sound Key";
  if (!lyrics) return null;
  
  return {
    detailed_analysis: detailed_analysis || null,
    title: title || "",
    lyrics: lyrics,
    style: styleFull,
  };
}

// ============================================================================
// ОТПРАВКА АУДИО ПОЛЬЗОВАТЕЛЮ
// ============================================================================

async function sendPhotoToUser(telegramUserId, photoUrl, caption) {
  if (!BOT_TOKEN || !telegramUserId) return { ok: false, error: "Нет BOT_TOKEN или chat_id" };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const body = new URLSearchParams({
    chat_id: String(telegramUserId),
    photo: photoUrl,
    caption: caption || "",
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

// Обновление логов этапов для админки (цепочка в окне заявки)
async function updateStepLog(requestId, steps) {
  try {
    await supabase.from('track_requests').update({ generation_steps: steps, updated_at: new Date().toISOString() }).eq('id', requestId);
  } catch (_) { /* колонка generation_steps может отсутствовать до миграции */ }
}

// ============================================================================
// ОСНОВНАЯ ФУНКЦИЯ ГЕНЕРАЦИИ
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function generateSoundKey(requestId) {
  const stepLog = {}; // логи этапов для админки
  try {
    if (!requestId || !UUID_REGEX.test(String(requestId))) {
      throw new Error(`Неверный ID заявки: нужен полный UUID с дефисами, получено: ${requestId}`);
    }
    console.log(`[Воркер] НАЧИНАЮ генерацию для ${requestId}`);
    const { data: request, error: reqError } = await supabase
      .from('track_requests')
      .select('*')
      .eq('id', requestId)
      .single();
    
    if (reqError || !request) {
      throw new Error(`Заявка ${requestId} не найдена: ${reqError?.message}`);
    }

    console.log(`[Воркер] Заявка получена: ${request.name}, режим: ${request.mode || "single"}`);
    console.log(`[Воркер] Запрос: "${(request.request || "").substring(0, 50)}..."`);
    
    // Сразу «забираем» заявку, чтобы workerGenerate (cron) не обработал её своим промптом из БД
    await supabase
      .from('track_requests')
      .update({ status: 'processing', generation_status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', requestId);
    stepLog['1'] = 'Данные получены, воркер запущен';
    await updateStepLog(requestId, stepLog);
    
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
    
    // Шаг 3: Получаем астро-снапшот из БД (по track_request_id)
    const { data: snapshotRow } = await supabase
      .from("astro_snapshots")
      .select("*")
      .eq("track_request_id", requestId)
      .maybeSingle();
    
    console.log(`[Воркер] Астро-данные получены для ${requestId}`);
    const astroTextFull = snapshotRow?.snapshot_text || "[Натальная карта не найдена]";
    const snapshot = snapshotRow?.snapshot_json && typeof snapshotRow.snapshot_json === "object" ? snapshotRow.snapshot_json : null;
    const pos = snapshot?.positions ?? [];
    const posBy = (name) => pos.find((p) => p.name === name);
    const sun = posBy("Солнце");
    const moon = posBy("Луна");
    const aspectsStr = (snapshot?.aspects ?? []).slice(0, 3).map((a) => `${a.p1}-${a.p2}: ${a.aspect}`).join(", ") || "—";
    
    let astroTextPerson2 = null;
    if (request.mode === "couple" && request.person2_name && request.person2_birthdate && request.person2_birthplace) {
      const coords2 = await geocode(request.person2_birthplace || "");
      if (coords2) {
        const m2 = String(request.person2_birthdate).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m2) {
          let hour2 = 12, minute2 = 0;
          if (!request.person2_birthtime_unknown && request.person2_birthtime) {
            const t2 = String(request.person2_birthtime).trim().match(/^(\d{1,2}):(\d{2})/);
            if (t2) { hour2 = parseInt(t2[1], 10); minute2 = parseInt(t2[2], 10); }
          }
          const snap2 = getAstroSnapshot({
            year: parseInt(m2[1], 10),
            month: parseInt(m2[2], 10),
            day: parseInt(m2[3], 10),
            hour: hour2,
            minute: minute2,
            latitude: coords2.lat,
            longitude: coords2.lon,
            timeUnknown: !!request.person2_birthtime_unknown,
          });
          if (snap2 && !snap2.error) astroTextPerson2 = snap2.snapshot_text;
        }
      }
      if (!astroTextPerson2) astroTextPerson2 = "[Натальная карта второго человека не рассчитана — недостаточно данных или геокодинг не удался]";
    }
    
    // Шаг 4: Формируем запрос — для одного или для двоих (полные натальные карты); в ответе ИИ НЕ упоминать термины
    const langLabel = request.language || "русский";
    let userRequest;
    if (request.mode === "couple" && request.person2_name && astroTextPerson2) {
      const g1 = (request.gender || "").toLowerCase();
      const g2 = (request.person2_gender || "").toLowerCase();
      let pairType = "нейтральный союз";
      if ((g1 === "male" && g2 === "female") || (g1 === "female" && g2 === "male") || (g1 === "м" && g2 === "ж") || (g1 === "ж" && g2 === "м")) {
        pairType = "семейная пара / влюблённые";
      } else if ((g1 === "female" && g2 === "female") || (g1 === "ж" && g2 === "ж")) {
        pairType = "подруги";
      } else if ((g1 === "male" && g2 === "male") || (g1 === "м" && g2 === "м")) {
        pairType = "друзья";
      }
      userRequest = `ЭТО ПАРА: ${request.name} и ${request.person2_name}

ПЕРВЫЙ ЧЕЛОВЕК:
Имя: ${request.name} (${request.gender || "—"})
Дата рождения: ${request.birthdate}
Место рождения: ${request.birthplace}
Время рождения: ${request.birthtime_unknown ? "неизвестно" : request.birthtime}

ВТОРОЙ ЧЕЛОВЕК:
Имя: ${request.person2_name} (${request.person2_gender || "—"})
Дата рождения: ${request.person2_birthdate}
Место рождения: ${request.person2_birthplace}
Время рождения: ${request.person2_birthtime_unknown ? "неизвестно" : request.person2_birthtime}

КОНФИГУРАЦИЯ ПОЛОВ: ${(request.gender || "—")}+${(request.person2_gender || "—")}
ТИП СОЮЗА: ${pairType}

ЗАПРОС ОТ ПАРЫ: "${request.request || "создать песню"}"

ЗАДАЧА: Проанализируй ОБЕ натальные карты и их связь с учётом половой конфигурации. Создай песню, которая отражает их союз как ${pairType} — взаимодополнение и общий путь. В ответе НЕ используй астрологические термины — только метафоры.

ПОЛНАЯ НАТАЛЬНАЯ КАРТА ПЕРВОГО ЧЕЛОВЕКА:
${astroTextFull}

ПОЛНАЯ НАТАЛЬНАЯ КАРТА ВТОРОГО ЧЕЛОВЕКА:
${astroTextPerson2}

ТРЕБОВАНИЕ: Песня должна строго отражать анализ обеих карт и их связь, без общих мест — только выводы из карт выше и запрос пары.

Язык песни и расшифровки: ${langLabel}`;
    } else if (request.mode === "transit" && (request.transit_date || request.transit_location)) {
      userRequest = `ЭТО ${request.name} (${request.gender || "—"}) — режим ЭНЕРГИЯ ДНЯ

НАТАЛЬНАЯ КАРТА (постоянная основа):
Имя: ${request.name}
Дата рождения: ${request.birthdate}
Место рождения: ${request.birthplace}
Время рождения: ${request.birthtime_unknown ? "неизвестно" : request.birthtime}

ТРАНЗИТЫ (энергия момента):
Дата транзита: ${request.transit_date || "—"}
Время транзита: ${request.transit_time || "не указано"}
Локация транзита: ${request.transit_location || "—"}
Намерение: ${request.transit_intent || "общий запрос"}

ЗАПРОС: "${request.request || "создать песню"}"

ЗАДАЧА: Проанализируй натальную карту и контекст указанной даты/времени/локации. Создай песню, которая отражает ЭНЕРГИЮ ЭТОГО МОМЕНТА — какие возможности открываются, какие вызовы возникают, как использовать эту энергию. В ответе НЕ используй астрологические термины — только метафоры.

ПОЛНАЯ НАТАЛЬНАЯ КАРТА:
${astroTextFull}

ТРЕБОВАНИЕ: Песня должна строго отражать энергию момента (транзит + натальная карта) и намерение, без общих мест — только из этого контекста.

Язык песни и расшифровки: ${langLabel}`;
    } else {
      userRequest = `ЭТО ${request.name} (${request.gender || "—"})
Дата рождения: ${request.birthdate}
Место рождения: ${request.birthplace}
Время рождения: ${request.birthtime_unknown ? "неизвестно" : request.birthtime}
Запрос: "${request.request || "создать песню"}"

Краткая выжимка (для ориентира): Атмакарака ${snapshot?.atmakaraka ?? "—"}, Солнце ${sun ? `${sun.sign} дом ${sun.house}` : "—"}, Луна ${moon ? `${moon.sign} дом ${moon.house}` : "—"}, аспекты: ${aspectsStr}

ПОЛНАЯ НАТАЛЬНАЯ КАРТА (все данные — используй для анализа; в своём ответе НЕ упоминай астрологические термины, только метафоры):
${astroTextFull}

ТРЕБОВАНИЕ: Песня должна строго отражать только этот анализ и этот запрос. Без общих мест и чужих тем — только то, что выведено из карты выше.

Язык песни и расшифровки: ${langLabel}`;
    }
    
    // ========== ЭТАП 1: DEEPSEEK ==========
    // Модель/temperature/max_tokens: приоритет app_settings (админка) > .env > дефолты.
    const CONTEXT_LIMIT = 128000;
    const SAFETY_BUFFER = 2000;
    const promptHash = crypto.createHash("sha256").update(SYSTEM_PROMPT).digest("hex");
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'bot/workerSoundKey.js:llm-start',message:'locked system prompt in use',data:{requestId:String(requestId||''),promptPath:LOCKED_PROMPT_PATH,promptLength:SYSTEM_PROMPT.length,promptHash:promptHash.slice(0,16)},timestamp:Date.now(),runId:'prompt-lock-debug',hypothesisId:'H1,H2'})}).catch(()=>{});
    // #endregion
    const estimatedInputTokens = Math.ceil((SYSTEM_PROMPT.length + userRequest.length) * 0.4);
    const maxFromContext = Math.max(1000, CONTEXT_LIMIT - estimatedInputTokens - SAFETY_BUFFER);
    let settingsMaxTokens = null;
    let settingsModel = null;
    let settingsTemperature = null;
    try {
      const { data: rows } = await supabase.from("app_settings").select("key, value").in("key", ["deepseek_max_tokens", "deepseek_model", "deepseek_temperature"]);
      (rows || []).forEach((r) => {
        if (r.key === "deepseek_max_tokens" && r.value != null) settingsMaxTokens = Math.max(1, Number(r.value));
        if (r.key === "deepseek_model" && String(r.value).trim()) settingsModel = String(r.value).trim();
        if (r.key === "deepseek_temperature" && r.value != null) { const t = Number(r.value); if (Number.isFinite(t)) settingsTemperature = t; }
      });
    } catch (_) {}
    // ВАЖНО: приоритет настроек из админки выше env, чтобы админка реально управляла генерацией.
    const rawModel = settingsModel || process.env.DEEPSEEK_MODEL || "deepseek-reasoner";
    const KNOWN_MODELS = ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"];
    const LLM_MODEL = KNOWN_MODELS.includes(rawModel) ? rawModel : "deepseek-reasoner";
    // Минимум 4096 для этого воркера (анализ + лирика). API DeepSeek валидирует max_tokens в диапазоне [1, 65536].
    const MIN_MAX_TOKENS = 4096;
    const API_MAX_TOKENS = 65536;
    const rawMax = settingsMaxTokens != null
      ? Number(settingsMaxTokens)
      : (process.env.DEEPSEEK_MAX_TOKENS != null ? Number(process.env.DEEPSEEK_MAX_TOKENS) : maxFromContext);
    const MAX_TOKENS_LLM = Math.min(API_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.max(1, Number(rawMax) || 8192)));
    if (rawMax != null && Number(rawMax) < MIN_MAX_TOKENS) {
      console.log(`[Воркер] 📌 max_tokens из настроек (${rawMax}) ниже минимума для генерации песни — использую ${MAX_TOKENS_LLM}`);
    }
    if (rawMax != null && Number(rawMax) > API_MAX_TOKENS) {
      console.log(`[Воркер] 📌 max_tokens из настроек (${rawMax}) выше лимита API ${API_MAX_TOKENS} — использую ${MAX_TOKENS_LLM}`);
    }
    const TEMPERATURE = settingsTemperature != null
      ? Number(settingsTemperature)
      : (process.env.DEEPSEEK_TEMPERATURE != null ? Number(process.env.DEEPSEEK_TEMPERATURE) : 1.5);
    const withSearch = !!SERPER_API_KEY;
    console.log(`[Воркер] 🤖 Отправляю запрос в DeepSeek (model=${LLM_MODEL}, max_tokens=${MAX_TOKENS_LLM}, temperature=${TEMPERATURE}, вход ~${estimatedInputTokens} ток.${withSearch ? ", поиск при генерации" : ""})...`);

    let llm = await chatCompletion(SYSTEM_PROMPT, userRequest, {
      model: LLM_MODEL,
      max_tokens: MAX_TOKENS_LLM,
      temperature: TEMPERATURE,
      ...(withSearch
        ? {
            tools: TOOLS_WITH_SEARCH,
            executeTool: async (name, args) => {
              if (name === "web_search") return await runWebSearch(args.query);
              return "Неизвестный инструмент";
            },
          }
        : {}),
    });
    if (!llm.ok && /Model Not Exist|model.*not.*exist/i.test(llm.error || "") && LLM_MODEL !== "deepseek-reasoner") {
      console.warn(`[Воркер] ⚠️ Модель "${LLM_MODEL}" недоступна (${llm.error}). Повтор с deepseek-reasoner...`);
      llm = await chatCompletion(SYSTEM_PROMPT, userRequest, {
        model: "deepseek-reasoner",
        max_tokens: MAX_TOKENS_LLM,
        temperature: TEMPERATURE,
        ...(withSearch
          ? {
              tools: TOOLS_WITH_SEARCH,
              executeTool: async (name, args) => {
                if (name === "web_search") return await runWebSearch(args.query);
                return "Неизвестный инструмент";
              },
            }
          : {}),
      });
    }
    if (!llm.ok) {
      throw new Error(`DeepSeek ошибка: ${llm.error}`);
    }
    
    const fullResponse = llm.text;
    const finishReason = llm.finish_reason || null;
    const llmTruncated = finishReason === "length";
    console.log(`[Воркер] 💾 СЫРОЙ ОТВЕТ DEEPSEEK (первые 500 символов):`);
    console.log(fullResponse.substring(0, 500));
    console.log(`[Воркер] 💾 ДЛИНА ОТВЕТА: ${fullResponse.length} символов`);
    console.log(`[Воркер] ✅ DeepSeek ответил (длина: ${fullResponse.length}), finish_reason: ${finishReason || "—"}${llm.usage ? `, completion_tokens: ${llm.usage.completion_tokens}` : ""}`);
    stepLog['2'] = `DeepSeek ответил, ${fullResponse.length} симв.${llmTruncated ? ' (обрезано)' : ''}`;
    await updateStepLog(requestId, stepLog);
    // Сразу сохраняем сырой ответ в БД (для диагностики и админки), даже если парсинг потом упадёт
    console.log(`[Воркер] 💾 Сохраняю сырой ответ в БД для ${requestId} (${fullResponse.length} симв.)...`);
    const { error: saveRawErr } = await supabase.from("track_requests").update({
      deepseek_response: fullResponse,
      detailed_analysis: fullResponse,
      llm_truncated: llmTruncated,
      updated_at: new Date().toISOString(),
    }).eq("id", requestId);
    if (saveRawErr) {
      console.error(`[Воркер] ❌ Не удалось сохранить deepseek_response для ${requestId}:`, saveRawErr.message, saveRawErr.code);
    } else {
      console.log(`[Воркер] 💾 deepseek_response сохранён в БД для ${requestId}`);
    }
    if (llmTruncated) {
      console.warn(`[Воркер] ⚠️ ОТВЕТ ОБРЕЗАН! Увеличьте max_tokens или сократите системный промпт.`);
    }
    
    // === ПРОВЕРКА КАЧЕСТВА ОТВЕТА (только лог, не блокируем — лирику проверим при парсинге) ===
    const MIN_RESPONSE_LENGTH = 1500;
    const REQUIRED_SECTIONS = [
      "СУТЬ ДУШИ",
      "ЭВОЛЮЦИОННЫЙ УРОВЕНЬ",
      "КЛЮЧЕВЫЕ ПРОТИВОРЕЧИЯ",
      "СИЛА И ТЕНЬ",
      "ПРАКТИЧЕСКИЕ РЕКОМЕНДАЦИИ",
    ];
    if (fullResponse.length < MIN_RESPONSE_LENGTH) {
      console.warn(`[Воркер] Ответ короткий (${fullResponse.length} символов) — продолжаем парсинг`);
    }
    for (const section of REQUIRED_SECTIONS) {
      if (!fullResponse.includes(section)) {
        console.warn(`[Воркер] В ответе нет раздела «${section}» — продолжаем`);
      }
    }
    const astroTerms = [
      "солнце", "луна", "меркурий", "венера", "марс", "юпитер",
      "сатурн", "уран", "нептун", "плутон", "асцендент", "дом",
      "знак зодиака", "овен", "телец", "близнецы", "рак", "лев",
      "дева", "весы", "скорпион", "стрелец", "козерог", "водолей", "рыбы",
    ];
    const responseLower = fullResponse.toLowerCase();
    for (const term of astroTerms) {
      if (responseLower.includes(term)) {
        console.warn(`[Воркер] В ответе есть термин «${term}» — желательно переформулировать в промпте`);
      }
    }
    
    // ========== ЭТАП 2: ПАРСИНГ ОТВЕТА ==========
    const parsed = parseResponse(fullResponse);
    if (!parsed || !parsed.lyrics) {
      const snippet = fullResponse.slice(0, 800).replace(/\n/g, " ");
      console.error(`[Воркер] Парсинг лирики: не найден блок [Verse 1] / [Chorus] / ЛИРИКА:. Начало ответа: ${snippet}...`);
      await supabase.from("track_requests").update({ deepseek_response: fullResponse, generation_status: "failed", error_message: "Не удалось извлечь лирику из ответа LLM", updated_at: new Date().toISOString() }).eq("id", requestId);
      throw new Error('Не удалось извлечь лирику из ответа LLM. Ответ сохранён в заявке — открой «Подробнее» в админке и проверь формат.');
    }
    let lyricsForSuno = sanitizeSongText(parsed.lyrics);
    const uppercaseBefore = countUppercaseChars(lyricsForSuno);
    lyricsForSuno = forceLyricsLowercase(lyricsForSuno);
    const uppercaseAfter = countUppercaseChars(lyricsForSuno);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/bc4e8ff4-db81-496d-b979-bb86841a5db1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'bot/workerSoundKey.js:lyrics-normalize',message:'lyrics lower-case normalization',data:{requestId:String(requestId||''),uppercaseBefore:uppercaseBefore,uppercaseAfter:uppercaseAfter,changed:uppercaseBefore!==uppercaseAfter},timestamp:Date.now(),runId:'lyrics-case-debug',hypothesisId:'H3'})}).catch(()=>{});
    // #endregion
    const lineCount = lyricsForSuno.split(/\n/).filter((l) => l.trim()).length;
    console.log(`[Воркер] ЭТАП 2 — Парсинг: лирика ${lyricsForSuno.length} символов, ${lineCount} строк; title="${parsed.title || ""}"; style длина=${(parsed.style || "").length}`);
    if (lineCount < 32) {
      throw new Error(`Песня слишком короткая (${lineCount} строк, нужно минимум 32)`);
    }
    stepLog['3'] = `Лирика: ${lineCount} строк, «${(parsed.title || "Sound Key").slice(0, 30)}»`;
    await updateStepLog(requestId, stepLog);
    
    // Сохраняем сырой ответ DeepSeek и аудит (контроль этапа 1)
    await supabase
      .from('track_requests')
      .update({
        deepseek_response: fullResponse,
        llm_truncated: llmTruncated,
        lyrics: lyricsForSuno,
        title: parsed.title,
        detailed_analysis: parsed.detailed_analysis,
        status: 'processing',
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId);
    
    // ========== ЭТАП 3: SUNO ==========
    const styleSentToSuno = parsed.style || "";
    console.log(`[Воркер] ЭТАП 3 — Suno: отправляю лирику ${lyricsForSuno.length} символов, title="${parsed.title}", style (первые 120 символов): ${styleSentToSuno.slice(0, 120)}${styleSentToSuno.length > 120 ? "…" : ""}`);

    const sunoParams = {
      prompt: lyricsForSuno,
      title: parsed.title,
      style: styleSentToSuno,
    };
    if (process.env.SUNO_MODEL) sunoParams.model = process.env.SUNO_MODEL;
    if (process.env.SUNO_VOCAL_GENDER === "m" || process.env.SUNO_VOCAL_GENDER === "f") sunoParams.vocalGender = process.env.SUNO_VOCAL_GENDER;

    const sunoStart = await generateMusic(sunoParams);
    if (!sunoStart.ok) {
      throw new Error(`Suno start ошибка: ${sunoStart.error}`);
    }
    
    console.log(`[Воркер] Задача в SUNO создана, taskId: ${sunoStart.taskId}`);
    
    await supabase
      .from('track_requests')
      .update({
        suno_task_id: sunoStart.taskId,
        suno_style_sent: styleSentToSuno,
      })
      .eq('id', requestId);
    
    // Шаг 9: Ожидание завершения генерации (используем существующий модуль)
    const sunoResult = await pollMusicResult(sunoStart.taskId);
    if (!sunoResult.ok) {
      throw new Error(`Suno poll ошибка: ${sunoResult.error}`);
    }
    
    const audioUrl = sunoResult.audioUrl;
    console.log(`[Воркер] ЭТАП 3 — Suno: музыка готова, audio_url=${audioUrl}`);
    stepLog['4'] = 'Аудио готово';
    await updateStepLog(requestId, stepLog);

    // Обложка: запрос + поллинг (не блокируем отправку песни при ошибке)
    let coverUrl = null;
    const coverStart = await generateCover(sunoStart.taskId);
    if (coverStart.ok && coverStart.coverTaskId) {
      const coverResult = await pollCoverResult(coverStart.coverTaskId);
      if (coverResult.ok && coverResult.coverUrl) {
        coverUrl = coverResult.coverUrl;
        console.log(`[Воркер] Обложка готова: ${coverUrl}`);
        stepLog['4'] = 'Аудио и обложка готовы';
        await updateStepLog(requestId, stepLog);
      } else {
        console.warn(`[Воркер] Обложка не получена: ${coverResult?.error || "—"}`);
      }
    } else {
      console.warn(`[Воркер] Запрос обложки не выполнен: ${coverStart?.error || "—"}`);
    }

    // Шаг 10: Обновить статус заявки и сохранить поля песни в БД (cover_url при наличии)
    const updatePayload = {
      status: 'completed',
      audio_url: audioUrl,
      detailed_analysis: fullResponse,
      lyrics: lyricsForSuno,
      title: parsed.title,
      language: 'ru',
      generation_status: 'completed',
      error_message: null,
      updated_at: new Date().toISOString()
    };
    if (coverUrl) updatePayload.cover_url = coverUrl;
    await supabase
      .from('track_requests')
      .update(updatePayload)
      .eq('id', requestId);

    // Шаг 11: Сначала обложка (если есть), затем аудио
    const caption = `🗝️ ${request.name}, твой звуковой ключ готов!\n\nЭто твоё персональное звуковое лекарство. Слушай каждое утро в тишине с закрытыми глазами.\n\nСлушай сердцем ❤️\n— YupSoul`;
    if (coverUrl) {
      await sendPhotoToUser(request.telegram_user_id, coverUrl, `Обложка твоей песни · ${parsed.title || "Звуковой ключ"}`).catch((e) => console.warn("[Воркер] Ошибка отправки обложки:", e?.message));
    }
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
      // Сообщение с опциональной поддержкой (реквизиты как на странице донатов)
      const donationText =
        `💫 Если песня коснулась твоей души — ты можешь поддержать создание таких ключей:\n\n` +
        `▫️ Приорбанк: 4916 9896 3237 0697\n` +
        `▫️ Альфа-банк: 4585 2200 0626 0623\n\n` +
        `Любая сумма от сердца. Это не оплата — это благодарность от сердца к сердцу ❤️\n\n` +
        `С любовью, — YupSoul`;
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: request.telegram_user_id,
            text: donationText
          })
        });
      } catch (e) {
        console.warn("[Воркер] Не удалось отправить сообщение о донате:", e?.message);
      }
    }
    
    return { ok: true, audioUrl };
    
  } catch (error) {
    console.error(`[Воркер] Ошибка генерации для заявки ${requestId}:`, error.message);
    if (typeof stepLog !== 'undefined') {
      stepLog['error'] = error.message?.slice(0, 200) || String(error);
      try { await updateStepLog(requestId, stepLog); } catch (_) {}
    }
    // Обновляем статус на failed (чтобы админка и другой воркер видели корректное состояние)
    const { error: updateErr } = await supabase
      .from('track_requests')
      .update({
        status: 'failed',
        generation_status: 'failed',
        error_message: error.message?.slice(0, 500),
        updated_at: new Date().toISOString()
      })
      .eq('id', requestId);
    if (updateErr) console.error('[Воркер] Не удалось обновить статус на failed:', updateErr.message);
    
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
