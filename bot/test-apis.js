/**
 * Тест API без Telegram: проверка DeepSeek и Suno.
 * Запуск: cd bot && node test-apis.js
 * Нужен .env с DEEPSEEK_API_KEY и SUNO_API_KEY.
 */

import "dotenv/config";
import { chatCompletion } from "./deepseek.js";
import { generateMusic } from "./suno.js";

async function main() {
  console.log("=== Тест DeepSeek ===\n");
  const deepseek = await chatCompletion(
    "Ты помощник. Отвечай кратко.",
    "Напиши одну строку: «DeepSeek работает» и текущую дату."
  );
  if (deepseek.ok) {
    console.log("DeepSeek: OK — API отвечает, ключ действует.");
    console.log("Ответ (первые 200 символов):", (deepseek.text || "").slice(0, 200));
    if (deepseek.usage) {
      console.log("Обратная связь API: usage =", deepseek.usage, "(total_tokens, completion_tokens)");
    }
    if (deepseek.finish_reason) {
      console.log("finish_reason:", deepseek.finish_reason, deepseek.finish_reason === "length" ? "(ответ обрезан по лимиту токенов)" : "");
    }
  } else {
    console.log("DeepSeek: ОШИБКА (обратный сигнал от API):", deepseek.error);
    console.log("Типичные коды: 401 — неверный ключ, 402 — нет баланса, 429 — лимит запросов.");
  }

  console.log("\n=== Тест Suno (только старт задачи) ===\n");
  const suno = await generateMusic({
    prompt: "[Verse 1]\nTest line one\n[Chorus]\nTest chorus\n",
    title: "API Test",
    style: "Ambient",
  });
  if (suno.ok) {
    console.log("Suno: OK, taskId:", suno.taskId);
    console.log("(Полный трек ждёт в воркере; здесь проверен только приём запроса.)");
  } else {
    console.log("Suno: ОШИБКА:", suno.error);
  }

  console.log("\n=== Готово ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
