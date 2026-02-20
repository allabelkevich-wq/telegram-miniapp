/**
 * Suno API — генерация музыки по тексту (custom mode), поллинг результата.
 * Base URL: https://api.sunoapi.org | Auth: Bearer YOUR_API_KEY
 * Документация: https://docs.sunoapi.org/suno-api/generate-music
 *   Get Music Generation Details, Callbacks — см. индекс llms.txt
 *
 * Модели: V4 (до 4 мин), V4_5 / V4_5PLUS / V4_5ALL (до 8 мин), V5 (лучшая экспрессия, быстрее).
 * Лимиты: prompt 5000 (V4 3000), style 1000 (V4 200), title — API принимает макс 80 символов.
 * Расширенные параметры (опционально): negativeTags, vocalGender (m/f), styleWeight, weirdnessConstraint, audioWeight (0–1), personaId.
 * Concurrency: 20 запросов / 10 сек.
 * Переменные: SUNO_API_KEY; опционально BACKEND_URL или SUNO_CALLBACK_URL; SUNO_MODEL (V5, V4_5ALL, …).
 */

const SUNO_BASE = "https://api.sunoapi.org/api/v1";
const POLL_INTERVAL_MS = 15000;
// Таймаут поллинга: по умолчанию 60 попыток × 15 с ≈ 15 мин; можно задать SUNO_POLL_MAX_ATTEMPTS в env
const POLL_MAX_ATTEMPTS = Math.max(40, Math.min(120, parseInt(process.env.SUNO_POLL_MAX_ATTEMPTS, 10) || 60));

/** Максимальная длина title в Suno API (ошибка "cannot exceed 80 characters" при большей длине). */
const TITLE_MAX = 80;

/**
 * Запуск генерации (custom mode). prompt = лирика, title и style обязательны.
 * Расширенные настройки: model, negativeTags, vocalGender, styleWeight, weirdnessConstraint, audioWeight, personaId.
 * @param {{
 *   prompt: string, title: string, style?: string, model?: string,
 *   negativeTags?: string, vocalGender?: 'm'|'f', styleWeight?: number, weirdnessConstraint?: number, audioWeight?: number, personaId?: string
 * }} params
 * @returns {Promise<{ ok: boolean, taskId?: string, error?: string }>}
 */
export async function generateMusic(params) {
  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "SUNO_API_KEY не задан" };
  }

  const {
    prompt,
    title,
    style = "Ambient, Cinematic, Soul",
    model = process.env.SUNO_MODEL || "V5",
    negativeTags,
    vocalGender,
    styleWeight,
    weirdnessConstraint,
    audioWeight,
    personaId,
  } = params;

  if (!prompt || !title) {
    return { ok: false, error: "prompt и title обязательны" };
  }

  const body = {
    customMode: true,
    instrumental: false,
    model: model || "V5",
    prompt: prompt.slice(0, 5000),
    title: String(title).slice(0, TITLE_MAX),
    style: (style || "Ambient, Cinematic").slice(0, 1000),
    callBackUrl: process.env.SUNO_CALLBACK_URL || (process.env.BACKEND_URL ? `${process.env.BACKEND_URL.replace(/\/$/, "")}/suno-callback` : "https://example.com/suno-callback"),
  };
  if (negativeTags != null && String(negativeTags).trim()) body.negativeTags = String(negativeTags).trim().slice(0, 500);
  if (vocalGender === "m" || vocalGender === "f") body.vocalGender = vocalGender;
  if (typeof styleWeight === "number" && styleWeight >= 0 && styleWeight <= 1) body.styleWeight = Math.round(styleWeight * 100) / 100;
  if (typeof weirdnessConstraint === "number" && weirdnessConstraint >= 0 && weirdnessConstraint <= 1) body.weirdnessConstraint = Math.round(weirdnessConstraint * 100) / 100;
  if (typeof audioWeight === "number" && audioWeight >= 0 && audioWeight <= 1) body.audioWeight = Math.round(audioWeight * 100) / 100;
  if (personaId != null && String(personaId).trim()) body.personaId = String(personaId).trim();

  try {
    const res = await fetch(`${SUNO_BASE}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (data.code !== 200) {
      return { ok: false, error: data.msg || `Suno ${res.status}` };
    }
    const taskId = data.data?.taskId;
    if (!taskId) return { ok: false, error: "Нет taskId в ответе Suno" };
    return { ok: true, taskId };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Поллинг статуса задачи до SUCCESS или ошибки. Возвращает первый audioUrl из sunoData.
 * @param {string} taskId
 * @returns {Promise<{ ok: boolean, audioUrl?: string, error?: string }>}
 */
export async function pollMusicResult(taskId) {
  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) return { ok: false, error: "SUNO_API_KEY не задан" };

  const url = `${SUNO_BASE}/generate/record-info?taskId=${encodeURIComponent(taskId)}`;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json().catch(() => ({}));
      if (data.code !== 200) {
        return { ok: false, error: data.msg || `Suno ${res.status}` };
      }
      const d = data.data || {};
      const status = d.status || "";
      if (status === "SUCCESS") {
        const sunoData = d.response?.sunoData;
        const first = Array.isArray(sunoData) && sunoData[0];
        const audioUrl = first?.audioUrl;
        // Suno возвращает imageUrl вместе с аудио в том же ответе
        const imageUrl = first?.imageUrl || first?.image_url || first?.coverUrl || null;
        if (audioUrl) return { ok: true, audioUrl, imageUrl };
        return { ok: false, error: "Нет audioUrl в ответе Suno" };
      }
      if (
        status === "CREATE_TASK_FAILED" ||
        status === "GENERATE_AUDIO_FAILED" ||
        status === "CALLBACK_EXCEPTION" ||
        status === "SENSITIVE_WORD_ERROR"
      ) {
        return { ok: false, error: d.errorMessage || status };
      }
    } catch (e) {
      if (i === POLL_MAX_ATTEMPTS - 1) return { ok: false, error: e?.message || String(e) };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, error: "Таймаут ожидания Suno" };
}

// ============================================================================
// ОБЛОЖКИ (Cover API)
// ============================================================================

const COVER_POLL_INTERVAL_MS = 10000;
const COVER_POLL_MAX_ATTEMPTS = 6; // до ~1 мин

/**
 * Запуск генерации обложки для уже сгенерированной музыки.
 * @param {string} musicTaskId — ID задачи генерации музыки (sunoStart.taskId).
 * @returns {Promise<{ ok: boolean, coverTaskId?: string, error?: string }>}
 */
export async function generateCover(musicTaskId) {
  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) return { ok: false, error: "SUNO_API_KEY не задан" };
  const callBackUrl =
    process.env.SUNO_COVER_CALLBACK_URL ||
    (process.env.BACKEND_URL ? `${process.env.BACKEND_URL.replace(/\/$/, "")}/suno-cover-callback` : null) ||
    "https://example.com/suno-cover-callback";

  try {
    const res = await fetch(`${SUNO_BASE}/suno/cover/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ taskId: musicTaskId, callBackUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.code !== 200) {
      return { ok: false, error: data.msg || `Suno Cover ${res.status}` };
    }
    const coverTaskId = data.data?.taskId;
    if (!coverTaskId) return { ok: false, error: "Нет taskId в ответе Suno Cover" };
    return { ok: true, coverTaskId };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Поллинг результата обложки. Возвращает первый URL из data.response.images.
 * @param {string} coverTaskId
 * @returns {Promise<{ ok: boolean, coverUrl?: string, error?: string }>}
 */
export async function pollCoverResult(coverTaskId) {
  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) return { ok: false, error: "SUNO_API_KEY не задан" };

  const url = `${SUNO_BASE}/suno/cover/record-info?taskId=${encodeURIComponent(coverTaskId)}`;
  for (let i = 0; i < COVER_POLL_MAX_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json().catch(() => ({}));
      if (data.code !== 200) {
        return { ok: false, error: data.msg || `Suno Cover ${res.status}` };
      }
      const d = data.data || {};
      const successFlag = d.successFlag;
      if (successFlag === 1) {
        const images = d.response?.images;
        const first = Array.isArray(images) && images[0];
        if (first && typeof first === "string") return { ok: true, coverUrl: first };
        if (first && typeof first === "object" && first.url) return { ok: true, coverUrl: first.url };
        return { ok: false, error: "Нет images в ответе Suno Cover" };
      }
      if (successFlag === 2) {
        return { ok: false, error: d.errorMessage || "Cover generation failed" };
      }
    } catch (e) {
      if (i === COVER_POLL_MAX_ATTEMPTS - 1) return { ok: false, error: e?.message || String(e) };
    }
    await new Promise((r) => setTimeout(r, COVER_POLL_INTERVAL_MS));
  }
  return { ok: false, error: "Таймаут ожидания обложки Suno" };
}
