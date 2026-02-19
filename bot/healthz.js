/**
 * Точка входа для Render: сразу поднимаем порт и отвечаем на /healthz (без загрузки Express/бота).
 * После этого подгружается index.js; он отдаёт app через globalThis, мы подхватываем запросы.
 * Mini App отдаём сразу из public/index.html — чтобы приложение открывалось без ожидания загрузки бота.
 */
import "dotenv/config";
import { createServer } from "http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MINI_APP_PATH = join(__dirname, "public", "index.html");

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
  // Mini App: отдаём сразу, не ждём загрузки бота — приложение открывается мгновенно
  if (url === "/" || url === "/app") {
    try {
      const html = readFileSync(MINI_APP_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("YupSoul Bot", "<h1>Запуск…</h1><p>Бот загружается. Подожди 10–20 сек и обнови страницу (F5).</p><p>Ошибка файла: " + (err?.message || err) + "</p><p><a href=\"/healthz\">/healthz</a></p>"));
    }
    return;
  }
  if (url.startsWith("/admin")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
    });
    res.end(page("YupSoul Bot", "<h1>Запуск…</h1><p>Админка загружается. Подожди 10–20 сек и обнови страницу (F5).</p><p><a href=\"/admin\">Обновить</a></p>"));
    return;
  }
  // Статика Mini App (/assets/*) пока бот грузится
  if (url.startsWith("/assets/") && !url.includes("..")) {
    try {
      const subPath = (pathPart || "").replace(/^\//, ""); // убираем ведущий слэш
      const filePath = join(__dirname, "public", subPath);
      const data = readFileSync(filePath);
      const ext = url.split(".").pop() || "";
      const ct = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct });
      res.end(data);
      return;
    } catch (_) {}
  }
  if (url.startsWith("/api")) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, error: "Сервис запускается. Подожди 20–30 сек и обнови страницу (F5)." }));
    return;
  }
  // Пути без расширения — отдаём Mini App (чтобы не было 404 после «Запуск…»)
  if (!(pathPart || "").includes(".")) {
    try {
      const html = readFileSync(MINI_APP_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    } catch (_) {}
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
      if (expressApp) {
        console.log("[healthz] Бот и API подключены. Запросы к /api и /admin теперь обрабатывает Express.");
      } else {
        console.error("[healthz] ВНИМАНИЕ: index.js не установил __EXPRESS_APP__. Проверь логи выше на ошибки загрузки.");
      }
    })
    .catch((e) => console.error("[healthz] Ошибка загрузки бота:", e?.message || e));
});
