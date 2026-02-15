# Политика цен и доступа (free → paid)

Документ описывает логику доступа к генерации в YupSoul.

## 1) Базовая модель

- Первый продукт: подарок (`trial_key = first_song_gift`), 1 раз на пользователя.
- Далее доступ открывается через:
  - разовую оплату (entitlement на SKU),
  - активную подписку (`subscriptions.status=active`, `renew_at >= now`),
  - промо-механику (`discount_percent`, `discount_amount`, `free_generation`).

## 2) SKU (по умолчанию)

- `single_song` — 5.99 USDT
- `transit_energy_song` — 6.99 USDT
- `couple_song` — 8.99 USDT
- `deep_analysis_addon` — 3.99 USDT
- `extra_regeneration` — 2.49 USDT
- `soul_basic_sub` — 14.99 USDT / месяц
- `soul_plus_sub` — 24.99 USDT / месяц

Источник правды: `pricing_catalog`.

## 3) Порядок проверки доступа

При создании заявки:

1. Активная подписка?
2. Есть entitlement по SKU (и remaining_uses > 0)?
3. Доступен trial?
4. Иначе — `payment_required`.

## 4) Промокоды

Проверки валидности:

- `active=true`;
- дата начала/окончания;
- совпадение SKU (если промокод SKU-специфичный);
- лимиты `max_uses`, `per_user_limit`.

Типы:

- `discount_percent` — скидка в %;
- `discount_amount` — фиксированная скидка;
- `free_generation` — итоговая сумма 0 и немедленный доступ.

## 5) Anti-abuse

- Идемпотентность по `payment_order_id` и `payment_tx_id`.
- Free trial фиксируется записью в `user_trials` (уникально по `telegram_user_id + trial_key`).
- На webhook обязательна проверка подписи.
- На create/status/confirm обязательна owner-проверка по `telegram_user_id`.

## 6) Что считаем успешной оплатой

Статусы webhook, считающиеся успешными:

- `paid`, `success`, `completed`, `confirmed` → нормализуются в `payment_status=paid`.

После `paid`:

- выдаётся entitlement / подписка,
- обновляется `track_requests.payment_*`,
- запускается генерация (если ещё не запущена).

