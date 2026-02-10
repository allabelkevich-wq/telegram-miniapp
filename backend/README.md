# YupSoul Backend

Бэкенд для Mini App: приём заявки, валидация initData, мок-генерация «песни» и **отправка результата пользователю в Telegram**.

## Быстрый старт

```bash
cd backend
cp .env.example .env
# В .env задай BOT_TOKEN (токен бота от @BotFather)
npm install
npm start
```

Сервер поднимется на `http://localhost:3000`.

## Переменные окружения

| Переменная   | Описание |
|-------------|----------|
| `BOT_TOKEN` | Токен бота Telegram (обязателен для валидации initData и отправки сообщений в бота). |
| `PORT`      | Порт (по умолчанию 3000). |

## API

- **GET /api/health** — проверка работы (без авторизации).
- **GET /api/me** — данные пользователя из initData (заголовок `Authorization: tma <initData>`).
- **POST /api/order** — заявка на звуковой ключ. Тело: `{ name, birthdate, birthplace, birthtime?, gender, request }`. После валидации initData генерируется мок-песня и **отправляется пользователю в бота** (сообщение с названием, текстом и ссылкой на трек).

## Деплой на Vercel

**Подробная пошаговая инструкция** (где установить, что нажимать): см. **[DEPLOY_VERCEL.md](./DEPLOY_VERCEL.md)**.

Кратко (CLI):
1. Установи [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`.
2. В терминале: `cd backend` → `vercel` (логин по необходимости, проект создастся).
3. В [Dashboard Vercel](https://vercel.com/dashboard) → твой проект → **Settings** → **Environment Variables**: добавь `BOT_TOKEN` (значение — токен бота).
4. Сделай **Redeploy** (Deployments → … → Redeploy), чтобы подхватить переменную.
5. Скопируй URL проекта (например `https://yupsoul-backend-xxx.vercel.app`) и в корневом `index.html` задай:  
   `const API_BASE = 'https://твой-проект.vercel.app';`  
   Затем залей обновлённый фронт на GitHub Pages.

После этого Mini App из бота будет слать заявки на этот URL, и пользователь будет получать песню в чате с ботом.

## Связка с Mini App

1. Разверни бэкенд и получи URL (например `https://yupsoul-api.vercel.app`).
2. В корневом `index.html` задай `const API_BASE = 'https://yupsoul-api.vercel.app';`.
3. Mini App открой из бота (Menu Button). При нажатии «Оплатить» заявка уйдёт на бэкенд, пользователь получит песню в чате с ботом.
