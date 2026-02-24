-- Добавить колонку stars_price в pricing_catalog для оплаты Telegram Stars
alter table pricing_catalog
  add column if not exists stars_price int;

comment on column pricing_catalog.stars_price is
  'Цена в Telegram Stars (XTR). NULL = недоступно для оплаты звёздами';

-- Проставить цены для всех существующих SKU
update pricing_catalog set stars_price = 460  where sku = 'single_song';
update pricing_catalog set stars_price = 540  where sku = 'transit_energy_song';
update pricing_catalog set stars_price = 690  where sku = 'couple_song';
update pricing_catalog set stars_price = 310  where sku = 'deep_analysis_addon';
update pricing_catalog set stars_price = 190  where sku = 'extra_regeneration';
update pricing_catalog set stars_price = 1150 where sku = 'soul_basic_sub';
update pricing_catalog set stars_price = 1920 where sku = 'soul_plus_sub';
update pricing_catalog set stars_price = 3070 where sku = 'master_monthly';
update pricing_catalog set stars_price = 230  where sku = 'soul_chat_1day';
