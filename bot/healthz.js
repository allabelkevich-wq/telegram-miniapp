/**
 * Точка входа для Render: сразу поднимаем порт и отвечаем на /healthz (без загрузки Express/бота).
 * После этого подгружается index.js; он отдаёт app через globalThis, мы подхватываем запросы.
 * Все ответы — HTML с текстом, чтобы в браузере не было пустого/серого экрана.
 * /webhook-info обрабатываем здесь через Telegram API, чтобы страница всегда открывалась.
 */
import "dotenv/config";
import { createServer } from "http";

process.env.RENDER_HEALTHZ_FIRST = "1";
const PORT = Number(process.env.PORT) || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
let expressApp = null;

const page = (title, body) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:sans-serif;padding:2rem;max-width:32rem;margin:0 auto;}</style></head><body>${body}</body></html>`;

const server = createServer(async (req, res) => {
  const fullUrl = req.url || "";
  const [pathPart, queryPart] = fullUrl.split("?");
  const url = (pathPart || "/").replace(/\/$/, "") || "/";
  const query = new URLSearchParams(queryPart || "");

  if (url === "/healthz") {
    if (query.get("webhook") === "1") {
      if (!BOT_TOKEN) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Webhook", "<h1>Статус webhook</h1><p>BOT_TOKEN не задан.</p><p><a href=\"/healthz\">/healthz</a></p>"));
        return;
      }
      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
        const data = await r.json();
        const whUrl = (data.ok && data.result && data.result.url) ? data.result.url : "(не установлен)";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Webhook", "<h1>Статус webhook</h1><p>URL: <strong>" + whUrl + "</strong></p><p>Если указан адрес — бот на Render не получает команды. При старте бот сбрасывает webhook. Redeploy → обнови страницу: должно быть «(не установлен)».</p><p><a href=\"/healthz\">/healthz</a></p>"));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Ошибка", "<p>Ошибка: " + (e?.message || e) + "</p><p><a href=\"/healthz\">/healthz</a></p>"));
      }
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page("YupSoul Bot", "<h1>Сервис работает</h1><p>Бот пробуждён — можно писать ему в Telegram.</p><p><a href=\"/healthz?webhook=1\">Статус webhook</a></p><p><a href=\"/\">Главная</a></p>"));
    return;
  }
  if (url === "/webhook-info") {
    res.writeHead(302, { Location: "/healthz?webhook=1" });
    res.end();
    return;
  }
  if (expressApp) {
    expressApp(req, res);
    return;
  }
  if (url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page("YupSoul Bot", "<h1>Запуск…</h1><p>Бот загружается. Подожди 10–20 сек и обнови страницу.</p><p>Если долго не грузится — смотри Render → Logs (возможна ошибка при старте).</p><p><a href=\"/healthz\">/healthz</a></p>"));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page("404", "<h1>404</h1><p>Страница не найдена.</p><p><a href=\"/\">Главная</a></p>"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[healthz] Порт открыт:", PORT);
  if (!process.env.BOT_TOKEN) {
    console.error("[healthz] BOT_TOKEN не задан. Добавь в Render → Environment (Environment Variables) и сделай Redeploy.");
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("[healthz] SUPABASE_URL или SUPABASE_SERVICE_KEY не заданы. Добавь в Render → Environment.");
    process.exit(1);
  }
  import("./index.js")
    .then(() => {
      expressApp = globalThis.__EXPRESS_APP__;
      if (expressApp) console.log("[healthz] Бот и API подключены");
    })
    .catch((e) => console.error("[healthz] Ошибка загрузки бота:", e?.message || e));
});
