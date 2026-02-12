# Suno API — документация для воркера

Воркер генерации звукового ключа (`bot/workerSoundKey.js`, `bot/workerGenerate.js`) использует **Suno API** для создания музыки по лирике. Ниже — краткая выжимка и ссылки на полную документацию.

## Официальная документация

- **Индекс всех страниц:** https://docs.sunoapi.org/llms.txt — используй для поиска нужного раздела.
- **Сайт документации:** https://docs.sunoapi.org  
- **О платформе:** [Suno API](https://sunoapi.org/) — регистрация, API Key, тарифы.

## Что использует наш воркер

| Компонент | Назначение |
|-----------|------------|
| **Base URL** | `https://api.sunoapi.org` |
| **Авторизация** | `Authorization: Bearer YOUR_API_KEY` (ключ из [API Key Management](https://sunoapi.org/api-key)) |
| **Эндпоинт генерации** | `POST /api/v1/generate` — запуск задачи по лирике (custom mode) |
| **Эндпоинт статуса** | `GET /api/v1/generate/record-info?taskId=...` — поллинг до SUCCESS, получение `audioUrl` |
| **Callback (опционально)** | Webhook на наш бэкенд: `POST /suno-callback` (см. `bot/index.js`) |

Реализация: `bot/suno.js` (`generateMusic`, `pollMusicResult`).

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `SUNO_API_KEY` | Обязательно. Ключ с [sunoapi.org](https://sunoapi.org/api-key). |
| `SUNO_MODEL` | Модель: `V5`, `V4_5`, `V4_5PLUS`, `V4_5ALL`, `V4`. По умолчанию в коде — `V5`. |
| `SUNO_CALLBACK_URL` | URL для webhook (уведомление о готовности). Если не задан — берётся `BACKEND_URL + /suno-callback`. |
| `SUNO_VOCAL_GENDER` | `m` или `f` — пол вокала (опционально). |
| `SUNO_NEGATIVE_TAGS` | Теги, которых избегать (опционально, часть воркеров). |

## Модели (кратко)

- **V5** — последняя модель, быстрее, лучше экспрессия (по умолчанию у нас).
- **V4_5 / V4_5PLUS / V4_5ALL** — до 8 минут, разное качество и структура.
- **V4** — до 4 минут, улучшенный вокал.

Лимиты: prompt до 5000 символов (V4 — 3000), style до 1000 (V4 — 200), title до 80–100 в зависимости от модели.

## Get Music Generation Details (`GET /api/v1/generate/record-info`)

Эндпоинт используется воркером для поллинга: передаётся `taskId` из ответа Generate Music, пока `status !== SUCCESS` или не произошла ошибка.

### Статусы задачи (status)

| Статус | Описание |
|--------|----------|
| `PENDING` | Задача в очереди |
| `TEXT_SUCCESS` | Текст/лирика сгенерированы |
| `FIRST_SUCCESS` | Первый трек готов |
| `SUCCESS` | Все треки готовы — в `response.sunoData[]` есть `audioUrl` |
| `CREATE_TASK_FAILED` | Ошибка создания задачи |
| `GENERATE_AUDIO_FAILED` | Ошибка генерации аудио |
| `CALLBACK_EXCEPTION` | Ошибка при вызове callback |
| `SENSITIVE_WORD_ERROR` | В контенте есть запрещённые слова |

При `SUCCESS` воркер берёт первый элемент `data.response.sunoData[0].audioUrl` (или `streamAudioUrl` для стриминга). В том же объекте есть `imageUrl`, `title`, `duration`, `createTime`.

При ошибке в ответе приходят `data.errorCode` и `data.errorMessage`.

### Заметки для разработчиков

- Проверять статус лучше через этот эндпоинт, а не полагаться только на callback.
- Для инструментальных треков (`instrumental=true`) в ответе не будет данных лирики.

### Коды ответа API (code)

| code | Значение |
|------|----------|
| 200 | Успех |
| 400 | Неверные параметры |
| 401 | Не авторизован (проверь API Key) |
| 404 | Неверный метод или путь |
| 405 | Превышен лимит запросов |
| 413 | Тема или prompt слишком длинные |
| 429 | Недостаточно кредитов |
| 430 | Слишком частые запросы, попробуй позже |
| 455 | Техобслуживание |
| 500 | Ошибка сервера |

Источник: [Get Music Generation Details](https://docs.sunoapi.org/suno-api/get-music-generation-details). Индекс документации: https://docs.sunoapi.org/llms.txt

## Get Timestamped Lyrics (`POST /api/v1/generate/get-timestamped-lyrics`)

Получение лирики с таймкодами для синхронного отображения при воспроизведении (например, караоке).

**Метод:** `POST`  
**Content-Type:** `application/json`  
**Тело запроса (оба поля обязательны):**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `taskId` | string | ID задачи генерации (из ответа Generate Music или record-info). |
| `audioId` | string | ID трека — уникальный идентификатор трека в рамках задачи. Берётся из `data.response.sunoData[].id` в ответе record-info при SUCCESS. Без `audioId` нельзя однозначно выбрать трек. |

**Ответ при успехе (code 200):**

| Поле | Описание |
|------|----------|
| `data.alignedWords` | Массив слов/фраз с таймкодами: `word`, `success`, `startS` (начало в секундах), `endS` (конец в секундах), `palign`. |
| `data.waveformData` | Массив чисел для визуализации волны аудио. |
| `data.hootCer` | Оценка точности выравнивания лирики. |
| `data.isStreamed` | Является ли аудио стриминговым. |

Типичное применение: плеер с подсветкой текущей строки по времени воспроизведения (`startS`/`endS` в секундах).

### Заметки для разработчиков

- Таймкоды в **секундах**.
- `waveformData` можно использовать для отрисовки волны в плеере.
- Для инструментальных треков (`instrumental=true`) лирика не возвращается.
- Ссылка: [Get Timestamped Lyrics](https://docs.sunoapi.org/suno-api/get-timestamped-lyrics).

## Boost Music Style (`POST /api/v1/style/generate`)

**Только для модели V4_5.** Улучшает текстовое описание стиля: короткую фразу или развёрнутый промпт превращает в итоговый текст стиля, который можно подставлять в параметр `style` при генерации музыки. Рекомендуется использовать для более точного контроля звучания.

**Метод:** `POST`  
**Content-Type:** `application/json`

**Тело запроса:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `content` | string | Обязательно. Описание стиля — кратко и ясно (пример: `Pop, Mysterious`) или развёрнуто, в разговорной форме (например: «Create a melodic, emotional deep house song featuring organic textures and hypnotic rhythms…»). |

**Ответ при успехе (code 200):**

| Поле | Описание |
|------|----------|
| `data.result` | Итоговый сгенерированный текст стиля — его можно передать в Generate Music как `style`. |
| `data.successFlag` | Результат выполнения: `0` — pending, `1` — success, `2` — failed. |
| `data.creditsConsumed` | Потрачено кредитов. |
| `data.creditsRemaining` | Остаток кредитов после запроса. |
| `data.errorCode`, `data.errorMessage` | При ошибке (successFlag=2). |

Типичный сценарий: описать желаемый стиль в `content` → получить `result` → использовать `result` в `POST /api/v1/generate` в поле `style`. Ссылка: [Boost Music Style](https://docs.sunoapi.org/suno-api/boost-music-style).

## Generate Music Cover (`POST /api/v1/suno/cover/generate`)

Создание персональных обложек для уже сгенерированной музыки.

**Метод:** `POST`  
**Тело запроса (JSON):**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `taskId` | string | Обязательно. ID задачи генерации музыки (из ответа Generate Music). |
| `callBackUrl` | string | Обязательно. URL для callback при завершении — в теле POST придёт `data.images` (массив URL картинок). |

**Ответ при успехе (code 200):** `data.taskId` — ID задачи генерации обложки. Статус и результат — через callback или [Get Cover Details](https://docs.sunoapi.org/suno-api/get-cover-suno-details) (`GET /api/v1/suno/cover/record-info?taskId=...`).

**Callback при готовности:** POST на `callBackUrl` с телом `{ code, msg, data: { taskId, images: [url1, url2] } }`. Обычно возвращается **2 варианта** обложки на выбор. Ссылки на файлы действуют **14 дней**.

### Заметки для разработчиков

- Для одной задачи музыки обложку можно сгенерировать **только один раз**. Повторный запрос вернёт **400** и уже существующий `taskId`.
- Вызывать лучше **после** успешного завершения генерации музыки (status SUCCESS).
- Детали и статус задачи обложки: [Get Music Cover Details](https://docs.sunoapi.org/suno-api/get-cover-suno-details). Callbacks: [Cover Callbacks](https://docs.sunoapi.org/suno-api/cover-suno-callbacks).

## Generate Lyrics (`POST /api/v1/lyrics`)

Генерация **только текста лирики** по описанию, без создания аудио. Возвращается несколько вариантов на выбор; в тексте обычно есть маркеры структуры (`[Verse]`, `[Chorus]` и т.д.). Результат можно передать в Generate Music (custom mode) как `prompt`.

**Метод:** `POST`  
**Тело запроса (JSON):**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `prompt` | string | Обязательно. Описание желаемой лирики: темы, настроение, стиль, структура. Чем детальнее — тем ближе результат. Лимит: **200 слов**. |
| `callBackUrl` | string | Обязательно. URL для callback при завершении. |

**Ответ при успехе (code 200):** `data.taskId` — ID задачи. Итог приходит в callback или через Get Lyrics Generation Details (см. ниже).

**Callback:** один этап — `complete`. Система шлёт POST на `callBackUrl` (Content-Type: application/json, таймаут **15 секунд**).

- **Успех (code 200):** `data.callbackType === "complete"`, `data.taskId`, `data.data` — массив вариантов: у каждого `text` (текст лирики, возможны `[Verse]`/`[Chorus]`), `title`, `status` (`complete`/`failed`), `errorMessage` (при failed).
- **Ошибка:** `code` 400 (параметры/контент), 451 (ошибка загрузки файлов), 500 (сервер); `data.callbackType === "error"`, `data.data` может быть `null`.

Рекомендации: отвечать 200 в течение 15 сек; обработку делать идемпотентной (один taskId может прийти несколько раз); сложную логику — асинхронно. Полное описание и примеры: [Lyrics Generation Callbacks](https://docs.sunoapi.org/suno-api/generate-lyrics-callbacks).

### Get Lyrics Generation Details (`GET /api/v1/lyrics/record-info`)

Поллинг статуса задачи генерации лирики: `GET ...?taskId=<taskId из POST /api/v1/lyrics>`.

**Статусы задачи (data.status):**

| Статус | Описание |
|--------|----------|
| `PENDING` | Задача в очереди |
| `SUCCESS` | Лирика сгенерирована |
| `CREATE_TASK_FAILED` | Ошибка создания задачи |
| `GENERATE_LYRICS_FAILED` | Ошибка генерации лирики |
| `CALLBACK_EXCEPTION` | Ошибка при вызове callback |
| `SENSITIVE_WORD_ERROR` | В контенте есть запрещённые слова |

При `SUCCESS`: в `data.response.data` — массив вариантов лирики, каждый с полями `text`, `title`, `status` (complete/failed), `errorMessage`. При ошибке задачи — `data.errorCode`, `data.errorMessage`.

Использовать для проверки статуса вместо ожидания callback; рекомендуется опрашивать примерно раз в 30 сек. Ссылка: [Get Lyrics Generation Details](https://docs.sunoapi.org/suno-api/get-lyrics-generation-details).

### Заметки для разработчиков

- Сгенерированные лирики хранятся **15 дней**.
- Использовать, когда нужен только текст без музыки; затем передать `text` в Generate Music как `prompt` в custom mode.
- Если callback недоступен — поллинг через Get Lyrics Generation Details (см. выше).

## File Upload API (временные файлы)

Сервис загрузки временных файлов для получения URL (например, для Upload and Cover Audio, Mashup и т.д.). **Загрузка бесплатная.** Все файлы **удаляются через 3 дня**; в ответе может быть поле `expiresAt`. Один и тот же API Key, что и для Suno.

**Base URL:** `https://sunoapiorg.redpandaai.co`  
**Авторизация:** `Authorization: Bearer YOUR_API_KEY`

| Способ | Эндпоинт | Когда использовать |
|--------|----------|--------------------|
| **URL** | `POST /api/file-url-upload` | Файл уже доступен по URL (миграция, пакетная обработка). Тело: `fileUrl`, `uploadPath`, `fileName`. Таймаут загрузки 30 сек, рекомендуется ≤100 MB. |
| **Stream** | `POST /api/file-stream-upload` | Локальный файл, в т.ч. большой. Multipart: `file`, `uploadPath`, `fileName`. Рекомендуется для >10 MB. |
| **Base64** | `POST /api/file-base64-upload` | Небольшие файлы (≤10 MB), удобно в JSON. Увеличивает объём ~33%. |

### File Stream Upload (`POST /api/file-stream-upload`)

**Content-Type:** `multipart/form-data`. Обязательные поля: **`file`** (бинарный файл), **`uploadPath`** (путь без слэшей по краям). По желанию **`fileName`** (если не задано — используется имя исходного файла). Рекомендуется для больших файлов (>10 MB); эффективность передачи выше Base64 примерно на 33%.  
**Ответ (success: true, code 200):** как у Base64 — `data.downloadUrl`, `data.fileName`, `data.filePath`, `data.fileSize`, `data.mimeType`, `data.uploadedAt`.

### Base64 File Upload (`POST /api/file-base64-upload`)

**Тело (JSON):** обязательные `base64Data` (строка Base64 или Data URL `data:image/png;base64,...`) и `uploadPath`; по желанию `fileName`.  
**Ответ (success: true, code 200):** `data.downloadUrl`, `data.fileName`, `data.filePath`, `data.fileSize`, `data.mimeType`, `data.uploadedAt` (и при наличии `data.expiresAt`).

Рекомендации: маленькие файлы (≤1 MB) — Base64; 1–10 MB — stream; большие — только stream. Уникальные имена (например, с датой) уменьшают конфликты и кэш. Подробнее: индекс https://docs.sunoapi.org/llms.txt → File Upload API.

## Полезные разделы официальной документации

- [Generate Music](https://docs.sunoapi.org/suno-api/generate-music) — генерация музыки, параметры, коды.
- [Get Music Generation Details](https://docs.sunoapi.org/suno-api/get-music-generation-details) — детали задачи, статусы.
- [Get Timestamped Lyrics](https://docs.sunoapi.org/suno-api/get-timestamped-lyrics) — лирика с таймкодами для караоке/плеера.
- [Boost Music Style](https://docs.sunoapi.org/suno-api/boost-music-style) — улучшение описания стиля (только V4_5).
- [Generate Music Cover](https://docs.sunoapi.org/suno-api/cover-suno) — обложки для треков (taskId + callBackUrl), 2 изображения, 14 дней.
- [Get Music Cover Details](https://docs.sunoapi.org/suno-api/get-cover-suno-details) — статус задачи обложки, поллинг.
- [Generate Lyrics](https://docs.sunoapi.org/suno-api/generate-lyrics) — только лирика по prompt (до 200 слов), несколько вариантов, callback complete.
- [Lyrics Generation Callbacks](https://docs.sunoapi.org/suno-api/generate-lyrics-callbacks) — формат callback (15 сек, code 200/400/451/500), примеры приёма.
- [Get Lyrics Generation Details](https://docs.sunoapi.org/suno-api/get-lyrics-generation-details) — статус задачи лирики, поллинг.
- [Music Generation Callbacks](https://docs.sunoapi.org/suno-api/generate-music-callbacks) — webhook при готовности трека.
- [Get Remaining Credits](https://docs.sunoapi.org/suno-api/get-remaining-credits) — проверка остатка кредитов.
- **File Upload API** — Base URL `https://sunoapiorg.redpandaai.co`: URL / Stream / Base64 загрузка, файлы 3 дня; см. индекс llms.txt → File Upload API Quickstart.

Полный список API и гайдов см. в индексе: https://docs.sunoapi.org/llms.txt
