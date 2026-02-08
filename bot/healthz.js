/**
 * Точка входа для Render: сразу поднимаем порт и отвечаем на /healthz (без загрузки Express/бота).
 * После этого подгружается index.js; он отдаёт app через globalThis, мы подхватываем запросы.
 */
import "dotenv/config";
import { createServer } from "http";

process.env.RENDER_HEALTHZ_FIRST = "1";
const PORT = Number(process.env.PORT) || 10000;
let expressApp = null;

const server = createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/healthz/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (expressApp) {
    expressApp(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[healthz] Порт открыт:", PORT);
  import("./index.js")
    .then(() => {
      expressApp = globalThis.__EXPRESS_APP__;
      if (expressApp) console.log("[healthz] Бот и API подключены");
    })
    .catch((e) => console.error("[healthz] Ошибка загрузки бота:", e?.message || e));
});
