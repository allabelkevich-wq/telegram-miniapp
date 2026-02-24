# Канонические UX-правила YupSoul Mini App

> **Этот файл — источник истины.** Перед каждым коммитом в `public/index.html` — проверить все пункты ниже. Если что-то изменилось — обновить этот документ.

Последнее обновление: v1.2.54

---

## ✅ Чек-лист перед деплоем

- [ ] Пол «Другой» не добавлен ни в один `<select>`
- [ ] Кнопка Soul Chat открывает `soulChatPage`, а не бота
- [ ] В чат-режиме Soul Chat нет заголовка/статистики — только диалог
- [ ] Поле ввода Soul Chat находится **вне** прокручиваемой зоны
- [ ] Кнопка «Перейти в бот» закрывает мини-апп (`tg.close()`)
- [ ] Кнопка «Написать в поддержку» использует `openTelegramLink` первой
- [ ] `.lang-switcher-compact { position: relative }` — не static
- [ ] Все `.page`-дивы закрыты до начала следующей страницы
- [ ] `.song-preview` — тёмный фон, не `background:white`

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

## История изменений

| Версия | Что изменилось |
|--------|---------------|
| v1.2.54 | Все правила введены: пол, Soul Chat, successPage, кнопки, язык |
| v1.2.53 | Исправлен незакрытый `<div>` formPage — Soul Chat был дочерним |
