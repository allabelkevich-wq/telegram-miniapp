/**
 * DeepSeek API (OpenAI-совместимый) — генерация текста по системному промпту и запросу.
 * Документация: base_url https://api.deepseek.com, Chat API: POST /v1/chat/completions.
 * Альтернатива: официальный SDK — npm install openai, baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY.
 *
 * Модели (актуальные названия и лимиты — в документации API):
 *   deepseek-chat — чат, выход обычно до 8K; надёжный дефолт.
 *   deepseek-coder-33b-instruct — код/текст, контекст 16K; для длинного выхода задай DEEPSEEK_MODEL и DEEPSEEK_MAX_TOKENS.
 *   deepseek-reasoner — если доступен в твоём эндпоинте, допускает больший вывод.
 *   V3.2-Speciale    — base_url https://api.deepseek.com/v3.2_speciale_expires_on_20251215 (до 15 дек 2025 UTC), без tool calls.
 * Функции: JSON, вызовы инструментов, автодополнение префиксов чата (бета). FIM (бета) только у chat.
 * Цены: 1M вход (cache hit) $0.028, (miss) $0.28; 1M выход $0.42. Списание с пополненного/предоставленного баланса.
 *
 * Token & Token Usage: токены — единицы биллинга (characters/words). Примерно: 1 English character ≈ 0.3 token, 1 Chinese character ≈ 0.6 token; соотношения зависят от модели. Фактическое число токенов — в ответе API (usage). Офлайн-расчёт: демо в deepseek_tokenizer.zip.
 *
 * Rate Limit: лимитов по частоте запросов нет; при высокой нагрузке ответ может задерживаться, соединение держится открытым. Нестриминг: сервер может присылать пустые строки до JSON — парсим body как text и извлекаем JSON. Если инференс не начался в течение 10 минут, сервер закрывает соединение.
 *
 * Temperature: default API 1.0. Рекомендации — Coding/Math 0.0, Data 1.0, Conversation/Translation 1.3, Creative Writing/Poetry 1.5.
 *
 * Error Codes (DeepSeek API):
 *   400 Invalid Format       — invalid request body; fix format per error message / API Docs
 *   401 Authentication Fails — wrong API key; check or create key
 *   402 Insufficient Balance — out of balance; Top up
 *   422 Invalid Parameters   — invalid params; fix per error message / API Docs
 *   429 Rate Limit Reached   — too many requests; pace requests or use alternative LLM
 *   500 Server Error         — server issue; retry after a brief wait
 *   503 Server Overloaded    — high traffic; retry after a brief wait
 *
 * Переменные: DEEPSEEK_API_KEY в .env. Опционально: DEEPSEEK_API_BASE_URL (например https://api-global.deepseek.com при проблемах с гео).
 */

const DEEPSEEK_BASE = (process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const DEEPSEEK_API_URL = `${DEEPSEEK_BASE}/v1/chat/completions`;
/** По умолчанию reasoner (V3.2, 128K, thinking) — лучше для длинного креатива (анализ + лирика) */
const DEFAULT_MODEL = "deepseek-reasoner";
/** Creative Writing / Poetry — анализ + лирика песни */
const DEFAULT_TEMPERATURE = 1.5;

const ERROR_CODES = {
  400: "Invalid Format — проверь тело запроса (API Docs)",
  401: "Authentication Fails — проверь или создай API key",
  402: "Insufficient Balance — пополни баланс (Top up)",
  422: "Invalid Parameters — исправь параметры по подсказке в ответе",
  429: "Rate Limit Reached — снизь частоту или используй другой LLM",
  500: "Server Error — повтори запрос через некоторое время",
  503: "Server Overloaded — повтори запрос через некоторое время",
};

/**
 * @param {string} systemPrompt — системный промпт (роль + инструкции)
 * @param {string} userMessage — сообщение пользователя (контекст/запрос)
 * @param {{ model?: string, max_tokens?: number, temperature?: number, tools?: object[], executeTool?: (name: string, args: object) => Promise<string> }} [opts]
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
export async function chatCompletion(systemPrompt, userMessage, opts = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "DEEPSEEK_API_KEY не задан" };
  }

  const model = opts.model || DEFAULT_MODEL;
  // DeepSeek API сейчас валидирует диапазон max_tokens как [1, 65536].
  const requested = Number(opts.max_tokens);
  const max_tokens = Math.floor(Math.min(65536, Math.max(1, Number.isFinite(requested) ? requested : 8192)));
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const tools = opts.tools;
  const executeTool = opts.executeTool;
  const maxToolRounds = 5;

  let messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const maxAttempts = 3;
  const retryStatuses = [500, 503];
  let lastError = null;
  let lastUsage = null;

  async function oneRound(bodyToSend) {
    const res = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(bodyToSend),
    });

    const raw = await res.text();
    const data = (() => {
      try {
        return JSON.parse(raw.trim());
      } catch {
        const start = raw.indexOf("{");
        if (start >= 0) {
          const end = raw.lastIndexOf("}") + 1;
          if (end > start) try { return JSON.parse(raw.slice(start, end)); } catch (_) {}
        }
        return {};
      }
    })();
    if (!res.ok) {
      const hint = ERROR_CODES[res.status] || res.statusText;
      const errMsg = data.error?.message || data.message || hint;
      if (res.status === 400 || res.status === 422) {
        console.error("[DeepSeek] Ответ API при ошибке:", JSON.stringify(data).slice(0, 500));
      }
      throw new Error(`DeepSeek API ${res.status} (${hint}): ${errMsg}`);
    }
    return data;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let round = 0;
      let currentMessages = [...messages];

      while (round < maxToolRounds) {
        const body = {
          model,
          messages: currentMessages,
          max_tokens,
          temperature,
          ...(tools && tools.length ? { tools } : {}),
        };

        const data = await oneRound(body);
        lastUsage = data.usage || null;
        const choice = data.choices?.[0];
        const msg = choice?.message;
        const toolCalls = msg?.tool_calls;

        if (toolCalls?.length && executeTool) {
          currentMessages.push({
            role: "assistant",
            content: msg.content || null,
            tool_calls: toolCalls,
          });
          for (const tc of toolCalls) {
            const name = tc.function?.name;
            let args = {};
            try {
              if (tc.function?.arguments) args = JSON.parse(tc.function.arguments);
            } catch (_) {}
            let result;
            try {
              result = await executeTool(name, args);
            } catch (e) {
              result = String(e?.message || e);
            }
            currentMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: typeof result === "string" ? result : JSON.stringify(result),
            });
          }
          round++;
          continue;
        }

        const content = msg?.content;
        if (content != null) {
          return {
            ok: true,
            text: String(content).trim(),
            finish_reason: choice?.finish_reason || null,
            usage: lastUsage ? { total_tokens: lastUsage.total_tokens, completion_tokens: lastUsage.completion_tokens } : null,
          };
        }
        if (toolCalls?.length && !executeTool) {
          return { ok: false, error: "Ответ содержит tool_calls, но executeTool не передан" };
        }
        return { ok: false, error: "Пустой ответ DeepSeek" };
      }

      return { ok: false, error: "Превышено число раундов вызова инструментов" };
    } catch (e) {
      lastError = e?.message || String(e);
      if (retryStatuses.some((s) => lastError.includes(String(s))) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      return { ok: false, error: lastError };
    }
  }
  return { ok: false, error: lastError || "Ошибка DeepSeek" };
}
