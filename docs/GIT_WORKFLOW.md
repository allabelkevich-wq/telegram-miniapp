# Git — только main

## Правило

**Вся разработка и деплой идут только через ветку `main`.**

- Все коммиты — в `main`
- Все пушки — в `main`
- Render деплоит только из `main`
- GitHub Pages деплоит только из `main`

Другие ветки не используются. Это убирает путаницу.

## Mini App: чтобы обновы попали в бот с первого раза

Правки интерфейса — только в **`public/index.html`**. На Render при сборке копируется то, что **уже в git** в ветке `main`. Если не сделать commit и push — в боте останется старая версия.

**Один раз после правок Mini App:**

```bash
./scripts/sync-and-deploy-miniapp.sh "описание правок"
```

Скрипт копирует `public/` в `bot/public/`, коммитит и пушит в `main`. Дальше Render сам соберёт и задеплоит. В Telegram закрой и снова открой приложение — увидишь новую версию (проверь номер версии внизу экрана).

**Pre-commit хук:** при коммите изменённого `public/index.html` автоматически подмешивается копия в `bot/public/index.html` и добавляется в тот же коммит — в репозитории не будет расхождений.

## Как работать (обычный цикл)

```bash
git checkout main
git pull origin main
# правки...
git add .
git commit -m "описание"
git push origin main
```

## Render

В Render Dashboard: Repository → Branch — убедись, что указана **main**. Тогда каждый push в main триггерит деплой.

## GitHub Pages

Уже настроено: деплой при push в `main` (см. `.github/workflows/deploy-pages.yml`).

## Удаление старых веток (однократно)

Если в репозитории остались ветки кроме main — их можно удалить:

```bash
git push origin --delete deploy/keepalive-and-birthplace
git push origin --delete fix/remove-debug-panel
git push origin --delete "cursor/-bc-fd376be5-ab92-4df8-8fa8-b5f824cdeaf8-a44c"
git push origin --delete cursor/cloud-agent-1771160378551-0kz9c
```
