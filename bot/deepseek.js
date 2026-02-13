/**
 * DeepSeek API (OpenAI-совместимый) — генерация текста по системному промпту и запросу.
 * Документация: base_url https://api.deepseek.com, Chat API: POST /v1/chat/completions.
 * Альтернатива: официальный SDK — npm install openai, baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY.
 *
 * Модели и лимиты (Models & Pricing):
 *   deepseek-chat    — DeepSeek-V3.2, non-thinking. Context 128K, max output DEFAULT 4K / MAX 8K. Поддержка Thinking in Tool-Use: api-docs.deepseek.com/guides/thinking_mode
 *   deepseek-reasoner — V3.2, thinking.     Context 128K, max output DEFAULT 32K / MAX 64K.
 *   deepseek-coder-33b-instruct — код/текст, context 16K, max_tokens до 8K (передаётся через opts.model в chatCompletion).
 *   V3.2-Speciale    — макс. рассуждения, API-only; base_url https://api.deepseek.com/v3.2_speciale_expires_on_20251215 (до 15 дек 2025 UTC), без tool calls, те же цены.
 * Цены: за 1M токенов (input cache hit $0.028, miss $0.28, output $0.42). Расчёт по input+output.
 *
 * Token & Token Usage: токены — единицы биллинга; ~1 англ. символ ≈ 0.3 токена, ~1 китайский ≈ 0.6. Фактическое число токенов возвращает API в usage; офлайн-расчёт — демо в deepseek_tokenizer.zip (документация Token & Token Usage).
 *
 * Rate Limit: лимитов по частоте запросов нет; при высокой нагрузке ответ может задерживаться, соединение держится открытым. Нестриминг: сервер может присылать пустые строки до JSON. Если инференс не начался в течение 10 минут, сервер закрывает соединение.
 *
 * Temperature (рекомендации DeepSeek): Coding/Math 0, Data 1.0, Conversation/Translation 1.3, Creative Writing/Poetry 1.5. Default API 1.0.
 *
 * Error Codes: 400 Invalid Format, 401 Authentication Fails, 402 Insufficient Balance, 422 Invalid Parameters, 429 Rate Limit Reached, 500 Server Error, 503 Server Overloaded (ретрай после паузы для 500/503).
 *
 * Переменные: DEEPSEEK_API_KEY в .env
 */

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-chat";
/** Creative Writing / Poetry — анализ + лирика песни */
const DEFAULT_TEMPERATURE = 1.5;

const ERROR_CODES = {
  400: "Invalid Format — проверь тело запроса",
  401: "Authentication Fails — проверь API key",
  402: "Insufficient Balance — пополни баланс",
  422: "Invalid Parameters — проверь параметры",
  429: "Rate Limit Reached — снизь частоту запросов",
  500: "Server Error — повтори запрос позже",
  503: "Server Overloaded — повтори запрос позже",
};

/**
 * @param {string} systemPrompt — системный промпт (роль + инструкции)
 * @param {string} userMessage — сообщение пользователя (контекст/запрос)
 * @param {{ model?: string, max_tokens?: number, temperature?: number }} [opts]
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
export async function chatCompletion(systemPrompt, userMessage, opts = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "DEEPSEEK_API_KEY не задан" };
  }

  const model = opts.model || DEFAULT_MODEL;
  const max_tokens = opts.max_tokens ?? 65536;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    max_tokens,
    temperature,
  };

  const maxAttempts = 3;
  const retryStatuses = [500, 503];
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = ERROR_CODES[res.status] || res.statusText;
        const errMsg = data.error?.message || data.message || hint;
        lastError = `DeepSeek API ${res.status} (${hint}): ${errMsg}`;
        if (retryStatuses.includes(res.status) && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        return { ok: false, error: lastError };
      }

      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      if (content == null) {
        return { ok: false, error: "Пустой ответ DeepSeek" };
      }
      const finishReason = choice?.finish_reason || null;
      const usage = data.usage || null;
      return {
        ok: true,
        text: String(content).trim(),
        finish_reason: finishReason,
        usage: usage ? { total_tokens: usage.total_tokens, completion_tokens: usage.completion_tokens } : null,
      };
    } catch (e) {
      lastError = e?.message || String(e);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return { ok: false, error: lastError || "Ошибка DeepSeek" };
}
