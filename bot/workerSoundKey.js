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

// ============================================================================
// РЕФЕРАЛЬНАЯ НАГРАДА
// ============================================================================
async function triggerReferralRewardIfEligible(refereeTelegramId) {
  if (!supabase || !BOT_TOKEN) return;
  const { data: referral } = await supabase.from('referrals')
    .select('*').eq('referee_id', Number(refereeTelegramId)).eq('reward_granted', false).maybeSingle();
  if (!referral || !referral.referrer_id) return;

  // Атомарно помечаем reward_granted = true (защита от двойного начисления при параллельных воркерах)
  const { data: claimed } = await supabase.from('referrals')
    .update({ reward_granted: true, reward_granted_at: new Date().toISOString(), activated_at: new Date().toISOString() })
    .eq('id', referral.id).eq('reward_granted', false).select('id');
  if (!claimed?.length) return; // уже выдано другим воркером

  // Начисляем кредит рефереру
  const { data: rp, error: rpErr } = await supabase.from('user_profiles')
    .select('referral_credits').eq('telegram_id', Number(referral.referrer_id)).maybeSingle();
  if (rpErr) {
    console.error('[Referral] Ошибка чтения профиля реферера:', rpErr.message);
    return;
  }
  if (!rp) {
    console.warn('[Referral] Профиль реферера не найден:', referral.referrer_id);
    return;
  }
  const { error: creditErr } = await supabase.from('user_profiles')
    .update({ referral_credits: (rp.referral_credits || 0) + 1 })
    .eq('telegram_id', Number(referral.referrer_id));
  if (creditErr) {
    console.error('[Referral] Ошибка начисления кредита:', creditErr.message);
    return;
  }

  // Уведомление рефереру в бот
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: referral.referrer_id,
        text: `🎁 *Твой друг получил первую песню по твоей ссылке!*\n\nТебе начислена 1 бесплатная генерация 🎵\nОткрой приложение, чтобы использовать её.`,
        parse_mode: 'Markdown',
      }),
    });
  } catch (e) {
    console.error('[Referral] Не удалось отправить уведомление рефереру:', e?.message);
  }
  console.log(`[Referral] Вознаграждение начислено: referee=${refereeTelegramId} → referrer=${referral.referrer_id}`);
}
// ============================================================================

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

ФОРМАТ СОПРОВОДИТЕЛЬНОГО ПИСЬМА:
Выводи блок "Сопроводительное письмо для [Имя]:" сразу после MUSIC PROMPT.
Строгая структура — 3 части:

1. Абзац-описание (2–3 предложения): что это за песня, её характер и главная тема. Личное, тёплое, без пафоса.

2. Блок рекомендаций по прослушиванию:
🎧 Рекомендация по выслушиванию (это важно!):
1. [конкретное, образное, с лёгким юмором если уместно]
2. [конкретное]
3. [конкретное]
4. [конкретное — про момент узнавания или инсайт]

3. Закрывающий абзац (2–3 предложения): тёплое напутствие, без банальностей.
Финальная строка — персональная, уникальная для этого человека и этой песни. По структуре похожа на «С уважением к [образ из сути этого человека]😌», но слова каждый раз свои — из темы, характера, метафор этой конкретной песни.

Обращение на «ты». Без астрологических терминов. Тон: тёплый, чуть игривый, точный.

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

const PROMPT_EXTENSION = `

### ДОПОЛНИТЕЛЬНЫЕ ИСТОЧНИКИ ДАННЫХ (используй при анализе):
- Если доступна Навамша (D-9) — анализируй отношения через неё.
- Если доступна Дашамша (D-10) — опирайся на неё в вопросах призвания.
- Если известны периоды (Даши) — укажи, какой жизненный сезон сейчас.
- Для пар — сравни обе натальные карты и их дробные карты.
- Никогда не называй источники ("по D-9..."), просто используй их содержание.

НИКАКИХ общих мотивационных фраз вроде "ты справишься", "всё будет хорошо", "поверь в себя".
Каждая строчка должна быть уникальной для этой души, основанной ТОЛЬКО на её карте.
Если в карте нет данных по теме — не придумывай.

Песня — это зеркало анализа.
Припев = мантра из рекомендаций.
Бридж = решение ключевого противоречия.
Куплеты = образы только из разделов "Суть души" и "Сила и тень".
Если в анализе нет темы — её не должно быть в песне.

НИКАКИХ упоминаний реальных людей, фильмов, книг, песен, брендов, городов (кроме места рождения).
Не сравнивай с другими душами.
`;
const EFFECTIVE_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n${PROMPT_EXTENSION}`.trim();

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

// Замена музыкальных терминов в сопроводительном письме на понятные слова
function humanizeCoverLetter(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/\bintro\b/gi, "вступление")
    .replace(/\boutro\b/gi, "финал")
    .replace(/\bpre-chorus\b/gi, "подводка")
    .replace(/\bpre chorus\b/gi, "подводка")
    .replace(/\bfinal chorus\b/gi, "завершающий припев")
    .replace(/\bbridge\b/gi, "средняя часть")
    .replace(/\bverse\b/gi, "куплет")
    .replace(/\bchorus\b/gi, "припев")
    .replace(/\bбридж\b/gi, "средняя часть")
    .replace(/\bкуплет[ые]?\b/gi, (m) => m) // куплет оставляем — это понятно
    .replace(/\[verse\s*\d?\]/gi, "")
    .replace(/\[chorus\]/gi, "")
    .replace(/\[bridge\]/gi, "")
    .replace(/\[intro\]/gi, "")
    .replace(/\[outro\]/gi, "");
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
  
  // Универсальный ограничитель конца лирики: MUSIC PROMPT / [style:] / СОПРОВОДИТЕЛЬНОЕ ПИСЬМО
  const LYRICS_END_PATTERN = /\n\s*(?:MUSIC PROMPT|КЛЮЧЕВЫЕ ПРИНЦИПЫ|СОПРОВОДИТЕЛЬНОЕ ПИСЬМО|\[style:\s*[^\]]+\]|\[vocal:\s*[^\]]+\])/i;

  // Лирика — от любого блока [Verse 1], [Verse 1:], [Chorus], [Intro] и т.д. до MUSIC PROMPT / [style:] / письма
  const lyricsStart = text.search(/\[(?:intro|verse\s*1|verse\s*2|pre-chorus|chorus|bridge|final\s*chorus|outro)\s*:?\]/i);
  if (lyricsStart >= 0) {
    const afterStart = text.slice(lyricsStart);
    const endMark = afterStart.search(LYRICS_END_PATTERN);
    lyrics = (endMark >= 0 ? afterStart.slice(0, endMark) : afterStart).trim();
  }
  // Запасной вариант: после "ЛИРИКА:" или "Лирика:" до [style:] / MUSIC PROMPT / письма
  if (!lyrics && /ЛИРИКА\s*:\s*|Lyrics?\s*:\s*/i.test(text)) {
    const afterLabel = text.replace(/^[\s\S]*?(ЛИРИКА|Lyrics?)\s*:\s*/i, "");
    const endMark = afterLabel.search(LYRICS_END_PATTERN);
    const block = endMark >= 0 ? afterLabel.slice(0, endMark) : afterLabel;
    if (block.trim().length > 100) lyrics = block.trim();
  }
  // Запасной: всё перед [style:] или MUSIC PROMPT или письмом, начиная с последнего вхождения Verse/Chorus/Куплет/Припев
  if (!lyrics) {
    const coverIdx = text.search(/\n\s*СОПРОВОДИТЕЛЬНОЕ ПИСЬМО/i);
    const styleIdx = text.indexOf("[style:");
    const endIdx = [coverIdx, styleIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? text.length;
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
  // Ещё запасной: от последнего «название» до [style:] или письма
  if (!lyrics) {
    const coverIdx2 = text.search(/\n\s*СОПРОВОДИТЕЛЬНОЕ ПИСЬМО/i);
    const styleIdx2 = text.indexOf("[style:");
    const end = [coverIdx2, styleIdx2].filter((i) => i > 0).sort((a, b) => a - b)[0] ?? text.length;
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

  // Сопроводительное письмо — отдельный блок после лирики и MUSIC PROMPT
  let cover_letter = "";
  const coverLetterIdx = text.search(/СОПРОВОДИТЕЛЬНОЕ ПИСЬМО ДЛЯ\s/i);
  if (coverLetterIdx >= 0) {
    // Берём всё после заголовка «СОПРОВОДИТЕЛЬНОЕ ПИСЬМО ДЛЯ Имя:»
    const afterHeader = text.slice(coverLetterIdx).replace(/^СОПРОВОДИТЕЛЬНОЕ ПИСЬМО ДЛЯ\s[^\n]*\n?/i, "").trim();
    // Письмо заканчивается на «КЛЮЧЕВЫЕ ПРИНЦИПЫ» или конце текста
    const endMark = afterHeader.search(/\n\s*КЛЮЧЕВЫЕ ПРИНЦИПЫ/i);
    cover_letter = (endMark >= 0 ? afterHeader.slice(0, endMark) : afterHeader).trim();
  }

  if (!title && lyrics) title = "Sound Key";
  if (!lyrics) return null;

  return {
    detailed_analysis: detailed_analysis || null,
    title: title || "",
    lyrics: lyrics,
    style: styleFull,
    cover_letter: cover_letter || null,
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

async function sendAudioToUser(telegramUserId, audioUrl, caption, { title = "", performer = "YupSoul" } = {}) {
  if (!BOT_TOKEN || !telegramUserId) return { ok: false, error: "Нет BOT_TOKEN или chat_id" };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`;
  const body = new URLSearchParams({
    chat_id: String(telegramUserId),
    audio: audioUrl,
    caption: caption || "Твой персональный звуковой ключ готов.",
    parse_mode: "Markdown",
  });
  if (title) body.set("title", title.slice(0, 128));
  if (performer) body.set("performer", performer.slice(0, 128));
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
  const setStep = async (key, value) => {
    stepLog[key] = value;
    await updateStepLog(requestId, stepLog);
  };
  const setStepCompat = async (legacyKey, value, namedKey = null) => {
    stepLog[legacyKey] = value;
    if (namedKey) stepLog[namedKey] = value;
    await updateStepLog(requestId, stepLog);
  };
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
    const paymentStatus = String(request.payment_status || "").toLowerCase();
    const generationAllowed = !paymentStatus || ["paid", "gift_used", "subscription_active"].includes(paymentStatus);
    if (!generationAllowed) {
      throw new Error(`Генерация заблокирована: требуется оплата (payment_status=${paymentStatus || "unknown"})`);
    }

    console.log(`[Воркер] Заявка получена: ${request.name}, режим: ${request.mode || "single"}`);
    console.log(`[Воркер] Запрос: "${(request.request || "").substring(0, 50)}..."`);
    
    // Сразу «забираем» заявку, чтобы workerGenerate (cron) не обработал её своим промптом из БД
    await supabase
      .from('track_requests')
      .update({ status: 'processing', generation_status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', requestId);
    await setStepCompat('1', 'Данные получены, воркер запущен', 'request_loaded');
    await setStep('pipeline_mode', request.mode || 'single');
    await setStep('astro_start', 'Запущен расчёт астроблока');
    
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
      await setStep('astro_snapshot_saved', `Снапшот сохранён: ${astroResult.astro_snapshot_id}`);
    } else {
      await setStep('astro_snapshot_saved', `Снапшот уже был: ${request.astro_snapshot_id}`);
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
    const hasDivisional = !!(snapshot?.divisional_charts && typeof snapshot.divisional_charts === "object");
    const hasDashas = !!(snapshot?.dashas && typeof snapshot.dashas === "object");
    await setStep('astro_extensions', `D-карты: ${hasDivisional ? 'ok' : 'нет'} · Даши: ${hasDashas ? 'ok' : 'нет'}`);
    
    let astroTextPerson2 = null;
    if (request.mode === "couple" && request.person2_name && request.person2_birthdate && request.person2_birthplace) {
      const person2FromSnapshot = snapshot?.person2_snapshot && typeof snapshot.person2_snapshot === "object"
        ? snapshot.person2_snapshot
        : null;
      if (person2FromSnapshot?.snapshot_text) {
        astroTextPerson2 = String(person2FromSnapshot.snapshot_text);
      }
      if (!astroTextPerson2 && person2FromSnapshot?.snapshot_json && typeof person2FromSnapshot.snapshot_json === "object") {
        try {
          astroTextPerson2 = JSON.stringify(person2FromSnapshot.snapshot_json, null, 2);
        } catch (_) {}
      }
      const coords2 = await geocode(request.person2_birthplace || "");
      if (!astroTextPerson2 && coords2) {
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
      await setStep('couple_second_snapshot', astroTextPerson2.startsWith("[")
        ? 'Второй снапшот: fallback/нет'
        : 'Второй снапшот: ok');
    }
    
    // Шаг 4: Формируем запрос — для одного или для двоих (полные натальные карты); в ответе ИИ НЕ упоминать термины
    const langMap = { ru: "Russian", en: "English", uk: "Ukrainian", de: "German", fr: "French" };
    const langLabel = langMap[request.language] || request.language || "Russian";
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
      const divisional = snapshot?.divisional_charts && typeof snapshot.divisional_charts === "object" ? snapshot.divisional_charts : {};
      const dashas = snapshot?.dashas && typeof snapshot.dashas === "object" ? snapshot.dashas : null;
      const transits = snapshot?.transits && typeof snapshot.transits === "object" ? snapshot.transits : null;
      const extBlock = [
        "ДОПОЛНИТЕЛЬНЫЕ ДАННЫЕ (используй при анализе, но НИКОГДА не называй источники — только метафоры):",
        divisional.D10 ? `- Призвание (D10): ${JSON.stringify(divisional.D10)}` : null,
        divisional.D9 ? `- Отношения (D9): ${JSON.stringify(divisional.D9)}` : null,
        divisional.D7 ? `- Творчество (D7): ${JSON.stringify(divisional.D7)}` : null,
        divisional.D4 ? `- Дом (D4): ${JSON.stringify(divisional.D4)}` : null,
        divisional.D30 ? `- Тень (D30): ${JSON.stringify(divisional.D30)}` : null,
        dashas ? `- Текущий период (Даши): ${JSON.stringify(dashas)}` : null,
        transits ? `- Энергия дня (Транзиты): ${JSON.stringify(transits)}` : null,
      ].filter(Boolean).join("\n");
      userRequest = `ЭТО ${request.name} (${request.gender || "—"})
Дата рождения: ${request.birthdate}
Место рождения: ${request.birthplace}
Время рождения: ${request.birthtime_unknown ? "неизвестно" : request.birthtime}
Запрос: "${request.request || "создать песню"}"

Краткая выжимка (для ориентира): Атмакарака ${snapshot?.atmakaraka ?? "—"}, Солнце ${sun ? `${sun.sign} дом ${sun.house}` : "—"}, Луна ${moon ? `${moon.sign} дом ${moon.house}` : "—"}, аспекты: ${aspectsStr}

ПОЛНАЯ НАТАЛЬНАЯ КАРТА (все данные — используй для анализа; в своём ответе НЕ упоминай астрологические термины, только метафоры):
${astroTextFull}
${extBlock ? "\n" + extBlock : ""}

ТРЕБОВАНИЕ: Песня должна строго отражать только этот анализ и этот запрос. Без общих мест и чужих тем — только то, что выведено из карты выше.

Язык песни и расшифровки: ${langLabel}`;
    }
    
    await setStep('prompt_compiled', 'Промт собран с расширенными правилами');

    // ========== ЭТАП 1: DEEPSEEK ==========
    // Модель/temperature/max_tokens: приоритет app_settings (админка) > .env > дефолты.
    const CONTEXT_LIMIT = 128000;
    const SAFETY_BUFFER = 2000;
    const promptHash = crypto.createHash("sha256").update(EFFECTIVE_SYSTEM_PROMPT).digest("hex");
    const estimatedInputTokens = Math.ceil((EFFECTIVE_SYSTEM_PROMPT.length + userRequest.length) * 0.4);
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

    await setStep('llm_request_start', `DeepSeek запрос: model=${LLM_MODEL}, max_tokens=${MAX_TOKENS_LLM}, temperature=${TEMPERATURE}`);
    let llm = await chatCompletion(EFFECTIVE_SYSTEM_PROMPT, userRequest, {
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
      llm = await chatCompletion(EFFECTIVE_SYSTEM_PROMPT, userRequest, {
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
    await setStepCompat('2', `DeepSeek ответил, ${fullResponse.length} симв.${llmTruncated ? ' (обрезано)' : ''}`, 'llm_response_ready');
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
      await setStep('llm_response_saved', `Ошибка сохранения DeepSeek: ${saveRawErr.message}`);
    } else {
      console.log(`[Воркер] 💾 deepseek_response сохранён в БД для ${requestId}`);
      await setStep('llm_response_saved', 'DeepSeek raw-ответ сохранён в БД');
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
    const lineCount = lyricsForSuno.split(/\n/).filter((l) => l.trim()).length;
    console.log(`[Воркер] ЭТАП 2 — Парсинг: лирика ${lyricsForSuno.length} символов, ${lineCount} строк; title="${parsed.title || ""}"; style длина=${(parsed.style || "").length}`);
    if (lineCount < 20) {
      throw new Error(`Песня слишком короткая (${lineCount} строк, нужно минимум 20)`);
    }
    if (lineCount < 32) {
      console.warn(`[Воркер] ⚠️ Лирика короче обычного (${lineCount} строк) — отправляем в Suno, но рекомендуем проверить промпт`);
    }
    await setStepCompat('3', `Лирика: ${lineCount} строк, «${(parsed.title || "Sound Key").slice(0, 30)}»`, 'lyrics_ready');
    
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

    await setStep('suno_start', 'Отправка задачи в Suno');
    const sunoStart = await generateMusic(sunoParams);
    if (!sunoStart.ok) {
      throw new Error(`Suno start ошибка: ${sunoStart.error}`);
    }
    
    console.log(`[Воркер] Задача в SUNO создана, taskId: ${sunoStart.taskId}`);
    await setStep('suno_task_created', `Suno taskId: ${sunoStart.taskId}`);
    
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
    // imageUrl часто приходит прямо в ответе на генерацию музыки
    const imageUrlFromMusic = sunoResult.imageUrl || null;
    console.log(`[Воркер] ЭТАП 3 — Suno: музыка готова, audio_url=${audioUrl}, image_url=${imageUrlFromMusic || "нет"}`);
    await setStepCompat('4', 'Аудио готово', 'audio_ready');

    // Обложка: сначала проверяем imageUrl из основного ответа, затем cover API
    let coverUrl = imageUrlFromMusic || null;
    if (coverUrl) {
      console.log(`[Воркер] Обложка получена из основного ответа Suno: ${coverUrl}`);
      await setStepCompat('4', 'Аудио и обложка готовы (из основного ответа)', 'cover_ready');
    } else {
      // Фолбек: отдельный cover API
      await setStep('cover_start', 'imageUrl не найден в аудио-ответе, пробуем cover API');
      const coverStart = await generateCover(sunoStart.taskId);
      if (coverStart.ok && coverStart.coverTaskId) {
        const coverResult = await pollCoverResult(coverStart.coverTaskId);
        if (coverResult.ok && coverResult.coverUrl) {
          coverUrl = coverResult.coverUrl;
          console.log(`[Воркер] Обложка получена через cover API: ${coverUrl}`);
          await setStepCompat('4', 'Аудио и обложка готовы (cover API)', 'cover_ready');
        } else {
          console.warn(`[Воркер] Обложка не получена через cover API: ${coverResult?.error || "—"}`);
          await setStep('cover_ready', `Обложка не получена: ${coverResult?.error || "—"}`);
        }
      } else {
        console.warn(`[Воркер] Cover API недоступен: ${coverStart?.error || "—"}`);
        await setStep('cover_ready', `Cover API недоступен: ${coverStart?.error || "—"}`);
      }
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
    const caption = `🎵 ${request.name}, твоя персональная песня готова!\n\n— YupSoul`;
    await setStep('delivery_start', 'Отправка пользователю (обложка/аудио)');
    if (coverUrl) {
      await sendPhotoToUser(request.telegram_user_id, coverUrl, `Обложка твоей песни · ${parsed.title || "Звуковой ключ"}`).catch((e) => console.warn("[Воркер] Ошибка отправки обложки:", e?.message));
    }
    const send = await sendAudioToUser(request.telegram_user_id, audioUrl, caption, {
      title: parsed.title || "Звуковой ключ",
      performer: request.name ? `YupSoul · ${request.name}` : "YupSoul",
    });
    
    if (!send.ok) {
      console.warn(`[Воркер] Ошибка отправки аудио: ${send.error}`);
      // Отправляем резервное сообщение
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: request.telegram_user_id,
            text: `🎵 ${request.name}, твоя персональная песня готова!\n\nАудиофайл временно недоступен для отправки. Напиши в поддержку — пришлём вручную в течение часа.\n\nСпасибо за терпение! ❤️`
          })
        });
      } catch (e) {
        console.error('[Воркер] Не удалось отправить резервное сообщение:', e.message);
      }
      await setStep('delivery_done', `Доставка с fallback: ${send.error}`);
    } else {
      console.log(`[Воркер] ✅ Заявка ${requestId} завершена для ${request.name}`);

      // Сопроводительное письмо — отдельным сообщением сразу после аудио
      const coverLetter = humanizeCoverLetter(parsed.cover_letter);
      if (coverLetter && coverLetter.length > 20) {
        try {
          const letterText = `Привет, ${request.name}! На связи YupSoul. Твой персональный музыкальный оракул, который понимает тебя без слов.\n\nЛови свой персональный трек — «${parsed.title || "Твоя песня"}»\n\n${coverLetter}`;
          // Telegram ограничивает длину сообщения 4096 символами
          const chunks = [];
          for (let i = 0; i < letterText.length; i += 4000) chunks.push(letterText.slice(i, i + 4000));
          for (const chunk of chunks) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: request.telegram_user_id, text: chunk, parse_mode: "Markdown" })
            });
          }
          await setStep('cover_letter_sent', `Письмо отправлено (${coverLetter.length} симв.)`);
        } catch (e) {
          console.warn("[Воркер] Не удалось отправить сопроводительное письмо:", e?.message);
          await setStep('cover_letter_sent', `Ошибка отправки письма: ${e?.message}`);
        }
      } else {
        console.warn(`[Воркер] Сопроводительное письмо не найдено или пустое — пропускаю`);
        await setStep('cover_letter_sent', 'Письмо не найдено в ответе LLM');
      }

      // Сообщение с опциональной поддержкой (реквизиты как на странице донатов)
      // MarkdownV2: номера карт в `code` — при тапе на Telegram автоматически копируются
      const donationText =
        `💫 Если песня коснулась твоей души — ты можешь поддержать создание таких ключей:\n\n` +
        `▫️ Приорбанк:\n\`4916 9896 3237 0697\`\n\n` +
        `▫️ Альфа\\-банк:\n\`4585 2200 0626 0623\`\n\n` +
        `Нажми на номер карты — он скопируется автоматически\\.\n\n` +
        `Любая сумма от сердца\\. Это не оплата — это благодарность ❤️\n— YupSoul`;
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: request.telegram_user_id,
            text: donationText,
            parse_mode: "MarkdownV2",
          })
        });
      } catch (e) {
        console.warn("[Воркер] Не удалось отправить сообщение о донате:", e?.message);
      }
      await setStep('delivery_done', 'Доставка пользователю успешна');
      // Проверяем и начисляем реферальную награду пригласившему
      try { await triggerReferralRewardIfEligible(request.telegram_user_id); }
      catch (e) { console.warn('[Referral] Ошибка начисления награды:', e?.message); }
    }
    await setStep('pipeline_done', 'Генерация полностью завершена');
    
    return { ok: true, audioUrl };
    
  } catch (error) {
    console.error(`[Воркер] Ошибка генерации для заявки ${requestId}:`, error.message);
    if (typeof stepLog !== 'undefined') {
      stepLog['error'] = error.message?.slice(0, 200) || String(error);
      stepLog['pipeline_done'] = 'Завершено с ошибкой';
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
