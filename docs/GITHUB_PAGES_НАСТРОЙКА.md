# Настройка Mini App на GitHub Pages

Пошаговая инструкция, чтобы раздать приложение через GitHub Pages и использовать его в Telegram вместо Render.

---

## Шаг 1: Включить GitHub Pages в репозитории

1. Откройте ваш репозиторий: **https://github.com/allabelkevich-wq/telegram-miniapp**
2. Перейдите в **Settings** (Настройки)
3. Слева выберите **Pages**
4. В разделе **Build and deployment**:
   - **Source:** выберите **GitHub Actions**
5. Сохраните (если есть кнопка Save)

---

## Шаг 2: Запустить деплой

Сделайте push в ветку `main` (например, небольшое изменение и коммит). Workflow автоматически задеплоит папку `public` на GitHub Pages.

Или откройте вкладку **Actions** в репозитории и вручную перезапустите последний workflow **Deploy to GitHub Pages**.

---

## Шаг 3: Узнать URL вашего приложения

После успешного деплоя URL будет:

```
https://allabelkevich-wq.github.io/telegram-miniapp/
```

Или, если репозиторий принадлежит организации:

```
https://<org-name>.github.io/telegram-miniapp/
```

*(Замените `allabelkevich-wq` на ваш GitHub username или имя организации.)*

---

## Шаг 4: Проверить в браузере

Откройте этот URL в браузере. Должна загрузиться главная страница YupSoul. API запросы идут на Render — бот и база работают как раньше.

---

## Шаг 5: Настроить кнопку меню в BotFather

1. Откройте @BotFather в Telegram
2. Отправьте `/mybots` → выберите вашего бота
3. **Bot Settings** → **Menu Button** → **Configure menu button**
4. Вставьте URL:
   ```
   https://allabelkevich-wq.github.io/telegram-miniapp
   ```
   (без слеша в конце)
5. Сохраните

---

## Шаг 6: Открыть Mini App в Telegram

Нажмите кнопку меню (☰) слева от поля ввода в чате с ботом. Должно открыться приложение, загруженное с GitHub Pages.

---

## Важно

- **API и бот остаются на Render** — только HTML приложения раздаётся с GitHub Pages
- **Бот не отвечает на команды?** Проверьте Render: логи, webhook, что сервис запущен. GitHub Pages влияет только на открытие приложения, не на команды бота
