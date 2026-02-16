# Подробная инструкция: деплой бэкенда на Vercel

> ⚠️ **Устарело.** Сейчас бот и API работают на **Render** (`telegram-miniapp-ar09.onrender.com`). Папка `backend/` не используется в продакшене. См. `docs/ДЕПЛОЙ_НА_RENDER.md`.

Есть два способа: через **сайт Vercel** (проще, без установки) или через **терминал** (Vercel CLI).

---

## Способ 1: Через сайт Vercel (рекомендуется)

Не нужно ничего ставить на компьютер — всё делается в браузере.

### Шаг 1. Аккаунт и проект

1. Зайди на **https://vercel.com** и войди (через GitHub, Google или email).
2. Нажми **«Add New…»** → **«Project»**.
3. Если репозиторий уже на GitHub:
   - Выбери репозиторий `telegram-miniapp` (или как он у тебя называется).
   - Нажми **Import**.
4. **Важно:** Vercel по умолчанию подхватывает корень репозитория. Нам нужна папка `backend`. В настройках импорта найди поле **Root Directory**:
   - Нажми **Edit** рядом с ним.
   - Укажи **`backend`** и сохрани.
5. Остальное (Framework Preset, Build Command) можно не менять. Нажми **Deploy**.

### Шаг 2. Переменная BOT_TOKEN

1. После первого деплоя откроется страница проекта. Сверху будет **Dashboard** → твой проект.
2. Зайди в **Settings** (вкладка вверху).
3. Слева выбери **Environment Variables**.
4. В поле **Key** введи: `BOT_TOKEN`  
   В поле **Value** вставь свой токен бота (от @BotFather).  
   Environment выбери **Production** (и при желании Preview).
5. Нажми **Save**.

### Шаг 3. Перезапуск деплоя

1. Открой вкладку **Deployments**.
2. У первого деплоя нажми три точки **⋯** → **Redeploy**.
3. Подтверди **Redeploy** (без «Use existing Build Cache» — чтобы подхватить переменные).
4. Дождись окончания (статус **Ready**).

### Шаг 4. URL бэкенда

1. Вверху страницы проекта будет домен, например:  
   **`https://telegram-miniapp-backend-xxx.vercel.app`**  
   или **`https://backend-xxx.vercel.app`** (если задавал имя).
2. Скопируй этот URL **без** слеша в конце — он тебе нужен для `API_BASE`.

### Шаг 5. Подключить Mini App к бэкенду

1. В корне репозитория открой файл **`index.html`** (рядом с папкой `backend`, не внутри неё).
2. В начале блока `<script>` найди строку:
   ```js
   const API_BASE = '';
   ```
3. Замени на (подставь свой URL из шага 4):
   ```js
   const API_BASE = 'https://твой-проект.vercel.app';
   ```
4. Сохрани, закоммить и запушь в GitHub. Если Mini App раздаётся через GitHub Pages — после пуша он начнёт ходить на твой бэкенд на Vercel.

Готово: заявки из бота будут уходить на Vercel, пользователь будет получать песню в чате.

---

## Способ 2: Через терминал (Vercel CLI)

Подходит, если тебе удобнее работать из командной строки.

### Шаг 1. Установить Vercel CLI

Открой терминал (на Mac это Terminal или встроенный терминал в Cursor/VS Code).

Установка через npm (нужен установленный [Node.js](https://nodejs.org)):

```bash
npm install -g vercel
```

- **Где ставится:** глобально в систему (доступно из любой папки).
- Если появится ошибка прав доступа, попробуй:  
  `sudo npm install -g vercel`  
  (введёшь пароль администратора).
- Проверка: выполни `vercel --version` — должна показаться версия.

### Шаг 2. Залогиниться в Vercel

```bash
vercel login
```

Откроется браузер или в терминале попросят ввести email — следуй подсказкам и заверши вход.

### Шаг 3. Деплой из папки backend

1. Перейди в папку бэкенда:
   ```bash
   cd /Users/yaroslavsibirskii/Desktop/git/telegram-miniapp/backend
   ```
   (или свой путь к репозиторию и папке `backend`.)

2. Запусти деплой:
   ```bash
   vercel
   ```

3. Ответь на вопросы:
   - **Set up and deploy?** — **Y** (Yes).
   - **Which scope?** — выбери свой аккаунт (Enter).
   - **Link to existing project?** — **N** (No), если проект первый раз.
   - **What’s your project’s name?** — можно оставить `backend` или ввести, например, `yupsoul-api`.
   - **In which directory is your code located?** — просто **./** (точка слэш) и Enter.

4. Дождись окончания. В конце будет строка вида:
   ```text
   Production: https://backend-xxx.vercel.app [copied to clipboard]
   ```
   Это и есть URL бэкенда.

### Шаг 4. Добавить BOT_TOKEN

1. Зайди на **https://vercel.com** → свой проект (например, `backend`).
2. **Settings** → **Environment Variables**.
3. **Key:** `BOT_TOKEN`  
   **Value:** твой токен бота от @BotFather.  
   Environment: **Production** (и при желании Preview).
4. **Save**.

### Шаг 5. Передеплой с переменной

В той же папке `backend` в терминале:

```bash
vercel --prod
```

Или в Dashboard Vercel: **Deployments** → **⋯** у последнего деплоя → **Redeploy**.

### Шаг 6. Прописать URL в index.html

Так же, как в способе 1 (шаг 5): в корне репозитория в **`index.html`** задай:

```js
const API_BASE = 'https://твой-проект.vercel.app';
```

(подставь реальный URL из вывода `vercel` или из Dashboard.)

---

## Проверка после деплоя

1. В браузере открой:  
   `https://твой-проект.vercel.app/api/health`  
   Должен вернуться JSON примерно такой:
   ```json
   { "ok": true, "service": "yupsoul-backend", "initDataConfigured": true }
   ```
2. Открой Mini App **из бота** (кнопка меню), заполни форму и нажми «Оплатить». В чате с ботом должно прийти сообщение с песней и ссылкой.

---

## Если что-то пошло не так

- **404 на /api/health** — проверь, что в настройках проекта Vercel в **Root Directory** указано **`backend`** (при деплое из корня репо).
- **initDataConfigured: false** в /api/health — переменная `BOT_TOKEN` не подхватилась. Добавь её в **Settings → Environment Variables** и сделай **Redeploy**.
- В боте не приходит сообщение — убедись, что пользователь хотя бы раз написал боту **/start** (чтобы бот мог писать в личку).
