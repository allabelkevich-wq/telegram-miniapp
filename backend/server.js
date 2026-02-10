import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { validate, parse } from '@tma.js/init-data-node';

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.warn('Предупреждение: BOT_TOKEN не задан. Валидация initData будет недоступна. Задайте BOT_TOKEN в .env');
}

app.use(cors());
app.use(express.json());

/**
 * Middleware: проверка заголовка Authorization: tma <initData>
 * и валидация подписи initData через токен бота.
 * При успехе в req.telegramUser попадают данные пользователя.
 */
function requireTelegramAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('tma ')) {
    return res.status(401).json({ error: 'Требуется авторизация: заголовок Authorization: tma <initData>' });
  }
  const initDataRaw = authHeader.slice(4).trim();
  if (!initDataRaw) {
    return res.status(401).json({ error: 'initData пустой' });
  }
  if (!BOT_TOKEN) {
    return res.status(503).json({ error: 'Сервер не настроен: отсутствует BOT_TOKEN' });
  }
  try {
    validate(initDataRaw, BOT_TOKEN);
    const parsed = parse(initDataRaw);
    req.telegramUser = parsed.user || null;
    req.initDataParsed = parsed;
    next();
  } catch (e) {
    const code = e.code || e.name || 'Unknown';
    return res.status(401).json({
      error: 'Неверные или устаревшие данные авторизации',
      code
    });
  }
}

/** Проверка работы сервера (без авторизации) */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'yupsoul-backend',
    initDataConfigured: !!BOT_TOKEN
  });
});

/** Данные текущего пользователя (требует initData в Authorization) */
app.get('/api/me', requireTelegramAuth, (req, res) => {
  res.json({
    ok: true,
    user: req.telegramUser,
    authDate: req.initDataParsed.authDate
  });
});

/**
 * Мок-генерация «песни» по заявке (MVP без реального пайплайна).
 * Возвращает объект { title, lyrics, trackUrl }.
 */
function mockGenerateTrack(name, userRequest) {
  const title = `Ключ для ${name}`;
  const shortRequest = (userRequest || 'твои цели').substring(0, 50);
  const lyrics = `✨ ${name}, твой звуковой ключ создан.\n\nНа основе запроса «${shortRequest}...» сгенерирована уникальная аудиокомпозиция — твой персональный артефакт для игры жизни.`;
  const trackUrl = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
  return { title, lyrics, trackUrl };
}

/**
 * Отправить пользователю в Telegram сообщение с результатом (песня/ссылка).
 */
async function sendSongToTelegram(chatId, name, title, lyrics, trackUrl) {
  const text = [
    `🎵 <b>${escapeHtml(title)}</b>`,
    '',
    lyrics.replace(/\n/g, '\n'),
    '',
    `▶️ <a href="${trackUrl}">Слушать трек</a>`
  ].join('\n');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    })
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Telegram API: ${r.status} ${err}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Отправка заявки на звуковой ключ.
 * Валидирует initData, генерирует мок-песню, отправляет её пользователю в бота.
 */
app.post('/api/order', requireTelegramAuth, async (req, res) => {
  const { name, birthdate, birthplace, birthtime, gender, request: userRequest } = req.body || {};
  if (!name || !birthdate || !birthplace || !gender || !userRequest) {
    return res.status(400).json({
      error: 'Не заполнены обязательные поля: name, birthdate, birthplace, gender, request'
    });
  }
  const userId = req.telegramUser?.id;
  const orderId = `yup-${Date.now()}-${userId || 'anon'}`;

  const { title, lyrics, trackUrl } = mockGenerateTrack(name, userRequest);

  if (userId && BOT_TOKEN) {
    try {
      await sendSongToTelegram(userId, name, title, lyrics, trackUrl);
    } catch (e) {
      console.error('Отправка в Telegram:', e);
      return res.status(502).json({
        error: 'Заявка принята, но не удалось отправить песню в бота. Попробуй написать боту /start и повтори.',
        orderId
      });
    }
  }

  res.json({
    ok: true,
    message: 'Заявка принята. Песня отправлена в бота.',
    orderId,
    userId,
    title,
    trackUrl
  });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log(`  GET  /api/health — проверка работы`);
    console.log(`  GET  /api/me    — данные пользователя (Authorization: tma <initData>)`);
    console.log(`  POST /api/order — заявка на ключ (Authorization: tma <initData>)`);
  });
}

export default app;
