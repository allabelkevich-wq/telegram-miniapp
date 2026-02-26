# Канонические UX-правила YupSoul Mini App

> **Этот файл — источник истины.** Перед каждым коммитом в `public/index.html` — проверить все пункты ниже. Если что-то изменилось — обновить этот документ.

Последнее обновление: v1.2.59

---

## ✅ Чек-лист перед деплоем

**Фронтенд (`public/index.html`):**
- [ ] Подсказки города идут через `getPlacesSearchUrl(q)` → при наличии бэкенда используется `/api/places`
- [ ] Пол «Другой» не добавлен ни в один `<select>`
- [ ] Кнопка Soul Chat открывает `soulChatPage`, а не бота
- [ ] В чат-режиме Soul Chat нет заголовка/статистики — только диалог
- [ ] Поле ввода Soul Chat находится **вне** прокручиваемой зоны
- [ ] Кнопка «Перейти в бот» закрывает мини-апп (`tg.close()`)
- [ ] Кнопка «Написать в поддержку» использует `openTelegramLink` первой
- [ ] `.lang-switcher-compact { position: relative }` — не static
- [ ] Все `.page`-дивы закрыты до начала следующей страницы
- [ ] `.song-preview` — тёмный фон, не `background:white`

**Бэкенд (`bot/index.js`):**
- [ ] Есть маршрут GET `/api/places?q=...` (прокси Nominatim для автовыбора города)
- [ ] `validatePromoForOrder` используется везде (не прямые запросы к `promo_codes`)
- [ ] Промокоды заблокированы для подписных SKU (`SUBSCRIPTION_SKUS`)
- [ ] Статус `processing` включён в фильтр `/api/admin/requests?status=pending`
- [ ] Статус `processing` учитывается отдельно в `/api/admin/stats`

**Админка (`bot/admin-simple.html`):**
- [ ] Ссылка «Написать» пользователю — `tg://user?id={id}`, не `t.me/@id{id}`
- [ ] Бейдж «В работе» суммирует `pending + processing + astro_calculated + lyrics_generated + suno_processing`

---

## 1. Пол — только male / female

В каждом `<select>` для пола: только два варианта. Вариант `other` запрещён.

**Затронутые элементы:** `id="gender"`, `id="gender2"`, `id="heroGender"`

```html
<!-- ✅ ПРАВИЛЬНО -->
<select id="gender" required>
  <option value="">Выбери</option>
  <option value="male">Мужской</option>
  <option value="female">Женский</option>
</select>

<!-- ❌ ЗАПРЕЩЕНО -->
<option value="other">Другой</option>
```

**Причина:** пользователи путаются, для чего это поле — непонятное UX.

---

## 2. Кнопка Soul Chat на главном экране

`id="soulChatBtn"` — только `goToPage('soulChatPage')`.

```js
// ✅ ПРАВИЛЬНО
soulChatBtn.addEventListener('click', () => goToPage('soulChatPage'));

// ❌ ЗАПРЕЩЕНО — открывает внешний бот вместо страницы
soulChatBtn.addEventListener('click', () => tg.openTelegramLink('https://t.me/...'));
```

**Причина:** Soul Chat — это страница внутри мини-апп, не отдельный бот.

---

## 3. Архитектура Soul Chat страницы

`soulChatPage` имеет **два режима** с раздельными DOM-зонами:

### Промо-режим (нет доступа)
| Элемент | Состояние |
|---------|-----------|
| `#scHeader` | видим — шапка с «Soul Chat» |
| `#scPromoArea` | видим — тарифы, описание |
| `#scChatHeader` | скрыт |
| `#scPageChat` | скрыт |
| `#scInputArea` | скрыт |

### Чат-режим (есть доступ)
| Элемент | Состояние |
|---------|-----------|
| `#scHeader` | скрыт |
| `#scPromoArea` | скрыт |
| `#scChatHeader` | видим — только кнопка «←» + таймер |
| `#scPageChat` | видим — `flex:1; overflow-y:auto` |
| `#scInputArea` | видим — `flex-shrink:0`, **вне скролла** |

**Правила:**
- В чат-режиме — никакого заголовка «Soul Chat», никакой статистики, никакого описания.
- Статистика доступна только через `#scMoreBtn` → `#scMoreContent` (кнопка «Подробнее ↓»).
- `#scInputArea` **никогда** не вкладывается в `page-scroll` или другой `overflow:auto/scroll` контейнер.

```
soulChatPage (position:fixed; display:flex; flex-direction:column)
├── #scHeader          (flex-shrink:0)  ← промо-режим
├── #scPromoArea       (flex:1; overflow-y:auto)  ← промо-режим
├── #scChatHeader      (flex-shrink:0)  ← чат-режим
├── #scPageChat        (flex:1; overflow-y:auto)  ← чат-режим
└── #scInputArea       (flex-shrink:0)  ← чат-режим, ВСЕГДА последний
```

---

## 4. Кнопка «Перейти в бот за песней» (successPage)

`id="openBotBtn"` — после открытия ссылки закрывает мини-апп через 400мс.

```js
// ✅ ПРАВИЛЬНО
openBotBtn.addEventListener('click', function() {
  openBotLink('song_ready');
  setTimeout(function() {
    try { if (tg && tg.close) tg.close(); } catch(e) {}
  }, 400);
});
```

**Причина:** без `tg.close()` пользователь «застрял» в мини-апп после нажатия.

---

## 5. Кнопка «Написать в поддержку»

`id="helpSupportBtn"` — порядок: сначала `openTelegramLink`, потом `openLink`.

```js
// ✅ ПРАВИЛЬНО — Telegram-ссылка открывается внутри Telegram
if (tg && tg.openTelegramLink) { tg.openTelegramLink(url); return; }
if (tg && tg.openLink)         { tg.openLink(url); return; }
window.open(url, '_blank');

// ❌ НЕВЕРНО — openLink открывает браузер, а не чат
if (tg && tg.openLink) { tg.openLink(url); return; }
```

---

## 6. Переключатель языка

CSS: `.lang-switcher-compact { position: relative }` — обязательно.

```css
/* ✅ ПРАВИЛЬНО */
#homeTopBar .lang-switcher-compact { position: relative; }
.lang-switcher-compact             { position: relative; }

/* ❌ ЗАПРЕЩЕНО — дропдаун уходит за границы экрана */
.lang-switcher-compact { position: static; }
```

**Причина:** `.lang-dropdown` имеет `position:absolute; top:calc(100%+4px)`. Без `position:relative` на родителе, `100%` = высота `homePage` → дропдаун уходит ниже экрана.

---

## 7. Структура страниц — незакрытые теги

Порядок `.page`-дивов в HTML (каждый закрывается до начала следующего):

```
formPage → loadingPage → successPage → soulChatPage → paymentThanksPage
```

**Скрипт проверки:**

```bash
python3 -c "
with open('public/index.html') as f: lines = f.readlines()
pages = ['formPage','loadingPage','successPage','soulChatPage','paymentThanksPage']
starts = {}
for i,l in enumerate(lines,1):
    if 'class=\"page\"' in l:
        for n in pages:
            if 'id=\"'+n+'\"' in l: starts[n]=i
for name in pages:
    s=starts.get(name)
    if not s: continue
    d=0
    for i,l in enumerate(lines[s-1:],s):
        d+=l.count('<div')-l.count('</div>')
        if d<=0 and i>s: print(name,'закрыт на стр.',i,'✓'); break
    else: print(name,'НЕ ЗАКРЫТ ❌')
"
```

**Почему это критично:** если `formPage` не закрыт, то `soulChatPage` становится его дочерним элементом. Когда `formPage` скрыт (`display:none`), Soul Chat тоже не виден — даже с классом `active`.

---

## 8. Оформление successPage

`.song-preview` — тёмный фон:

```css
/* ✅ ПРАВИЛЬНО */
.song-preview {
  background: rgba(212,175,55,0.06);
  border: 1px solid rgba(212,175,55,0.25);
  color: rgba(255,255,255,0.6);
}

/* ❌ ЗАПРЕЩЕНО — белое окно на тёмном фоне */
.song-preview { background: white; }
```

---

## 9. Бизнес-правило: промокоды — только на разовые покупки

Промокоды действуют **исключительно** на:
- разовую песню (`single_song`, `couple_song`, `transit_energy_song`)
- разовый день Soul Chat (`soul_chat_day`)

**На подписки промокодов нет и быть не должно** (`soul_basic_sub`, `soul_plus_sub`, `master_monthly`).

В `bot/index.js` это закреплено в `validatePromoForOrder`:

```js
const SUBSCRIPTION_SKUS = new Set(["soul_basic_sub", "soul_plus_sub", "master_monthly"]);
// ...
if (sku && SUBSCRIPTION_SKUS.has(String(sku))) return { ok: false, reason: "sku_mismatch" };
```

`/api/payments/subscription/checkout` не принимает и не читает `promo_code` — это намеренно.

---

---

## 10. Статусы заявок в админке (`bot/index.js` + `bot/admin-simple.html`)

### Полная статусная модель `generation_status`

| Статус | Описание | Финальный? |
|--------|----------|-----------|
| `pending` | Ожидает обработки | нет |
| `processing` | Воркер активно работает | нет |
| `astro_calculated` | Астро-расчёт выполнен | нет |
| `lyrics_generated` | Текст песни сгенерирован | нет |
| `suno_processing` | Генерация аудио в Suno | нет |
| `pending_payment` | Ожидает оплаты | нет |
| `completed` | Готово и доставлено | ✅ да |
| `delivery_failed` | Не удалось доставить | ✅ да |
| `failed` | Ошибка генерации | ✅ да |
| `cancelled` | Отменено | ✅ да |

### Правило: фильтр «В работе» включает `processing`

```js
// ✅ ПРАВИЛЬНО — в /api/admin/requests
if (statusFilter === "pending")
  q = q.in("generation_status", ["pending", "processing", "astro_calculated", "lyrics_generated", "suno_processing"]);

// ❌ НЕВЕРНО — processing выпадает из списка
q = q.in("generation_status", ["pending", "astro_calculated", "lyrics_generated", "suno_processing"]);
```

### Правило: бейдж «В работе» в admin-simple.html

```js
// ✅ ПРАВИЛЬНО
document.getElementById('pending').textContent =
  (s.pending || 0) + (s.processing || 0) + (s.astro_calculated || 0) +
  (s.lyrics_generated || 0) + (s.suno_processing || 0);
```

**Почему критично:** `processing` начислялся в счётчик через `else → stats.pending`, но не попадал в фильтр списка → бейдж показывал «2 в работе», список был пустым.

### Watchdog — защита от застревания

Заявки зависшие в `processing` > 20 мин автоматически сбрасываются в `pending` и перезапускаются (`STALE_PROCESSING_MS = 20 * 60 * 1000`).

---

## 11. Ссылки на пользователей Telegram в админке

Для открытия чата с пользователем по числовому ID — только `tg://` deep link.

```html
<!-- ✅ ПРАВИЛЬНО — открывает Telegram app -->
<a href="tg://user?id={telegram_user_id}">✉️ Написать</a>

<!-- ❌ НЕ РАБОТАЕТ — Telegram не обрабатывает этот формат -->
<a href="https://t.me/@id{telegram_user_id}">✉️ Написать</a>
```

**Затронутые места в `admin-simple.html`:**
- Детальная карточка заявки (кнопка «✉️ Написать»)
- Бейдж с ID в строке списка заявок (`tg-id-badge`)

---

## 12. Автовыбор города (подсказки места рождения и локации)

Подсказки городов (выпадающий список при вводе 2+ символов) **всегда** идут через бэкенд-прокси, а не напрямую к Nominatim из Mini App. Иначе в WebView возможны CORS или блокировки — автовыбор перестаёт работать.

### Правило

| Где | Элементы | Источник подсказок |
|-----|----------|---------------------|
| Форма заявки | `#birthplace`, `#birthplaceSuggestions` | `getPlacesSearchUrl(q)` → при наличии `BACKEND_URL`/`HEROES_API_BASE`: `base + '/api/places?q=' + ...` |
| Второй человек | `#birthplace2`, `#birthplaceSuggestions2` | то же |
| Форма героя (Лаборатория) | `#heroBirthplace`, `#heroBirthplaceSuggestions` | то же |
| Энергия момента (транзит) | `#transitLocation`, `#transitLocationSuggestions` | `showLocationSuggestions()` использует `getPlacesSearchUrl(value)` |

### Фронтенд (`public/index.html`)

- Функция **`getPlacesSearchUrl(q)`** — единственное место выбора URL для поиска мест:
  - если заданы `window.BACKEND_URL` или `window.HEROES_API_BASE` → `base + '/api/places?q=' + encodeURIComponent(q)`;
  - иначе (локальная отладка) → прямой URL Nominatim с параметрами `format=json&limit=8&addressdetails=1`.
- Все четыре блока подсказок (birthplace, birthplace2, heroBirthplace, transitLocation) вызывают этот URL; при прямом Nominatim в `fetch` передаётся заголовок `User-Agent: YupSoulMiniApp/1.0`.

### Бэкенд (`bot/index.js`)

- Маршрут **GET `/api/places?q=...`** обязателен. Он проксирует запрос к Nominatim с заголовком `User-Agent: YupSoulMiniApp/1.0 (contact@yupsoul.com)` и возвращает JSON-массив в том же формате (display_name, lat, lon, address). При ошибке или пустом `q` — ответ `[]` или 400/502 с пустым массивом.

**Причина:** в Mini App (Telegram WebView) прямые запросы к nominatim.openstreetmap.org могут блокироваться или не проходить CORS — тогда выпадающий список городов «исчезает». Прокси на своём бэкенде устраняет эту проблему.

---

## История изменений

| Версия | Что изменилось |
|--------|---------------|
| v1.2.59 | Правило 12: автовыбор города — подсказки только через бэкенд `/api/places`, getPlacesSearchUrl в Mini App |
| v1.2.58 | Правила 10–11: статусы заявок, фильтр processing, tg:// ссылки |
| v1.2.57 | Бизнес-правило: промокоды только на разовые покупки, не на подписки |
| v1.2.56 | Безопасность промокодов: validatePromoForOrder везде, расширены тексты ошибок |
| v1.2.54 | Все правила введены: пол, Soul Chat, successPage, кнопки, язык |
| v1.2.53 | Исправлен незакрытый `<div>` formPage — Soul Chat был дочерним |
