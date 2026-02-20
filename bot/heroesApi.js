/**
 * HTTP API для модуля «Мои герои» (тариф Мастер).
 * Валидация Telegram Web App initData, CRUD клиентов, отдача тарифа.
 */

import express from "express";
import crypto from "node:crypto";

const router = express.Router();
router.use(express.json({ limit: "500kb" }));

/**
 * Валидация initData из Telegram Mini App.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== "string" || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (computed !== hash) return null;
  const userStr = params.get("user");
  let telegramUserId = null;
  if (userStr) {
    try {
      const user = JSON.parse(decodeURIComponent(userStr));
      telegramUserId = user.id ?? user.user_id;
    } catch (_) {}
  }
  return telegramUserId;
}

/**
 * Создаёт или возвращает app_user по telegram_user_id.
 */
async function getOrCreateAppUser(supabase, telegramUserId) {
  const { data: existing, error: selErr } = await supabase
    .from("app_users")
    .select("id, tariff")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  // Таблица не создана — возвращаем дефолт вместо 500
  if (selErr && /does not exist|relation/i.test(selErr.message)) {
    return { id: String(telegramUserId), tariff: "basic" };
  }
  if (existing) return existing;
  const { data: inserted, error } = await supabase
    .from("app_users")
    .insert({ telegram_user_id: telegramUserId, tariff: "basic" })
    .select("id, tariff")
    .single();
  if (error && /does not exist|relation/i.test(error.message)) {
    return { id: String(telegramUserId), tariff: "basic" };
  }
  if (error) return null;
  return inserted;
}

function createHeroesRouter(supabase, botToken) {
  if (!supabase || !botToken) {
    router.use((_req, res) => res.status(503).json({ error: "Heroes API недоступен: нет Supabase или BOT_TOKEN" }));
    return router;
  }

  router.post("/me", async (req, res) => {
    const initData = req.body?.initData ?? req.headers["x-telegram-init"];
    const telegramUserId = validateInitData(initData, botToken);
    if (telegramUserId == null) {
      return res.status(401).json({ error: "Неверные или устаревшие данные авторизации" });
    }
    const appUser = await getOrCreateAppUser(supabase, telegramUserId);
    if (!appUser) return res.status(500).json({ error: "Не удалось получить профиль" });
    return res.json({ tariff: appUser.tariff || "basic", app_user_id: appUser.id });
  });

  const HERO_SELECT = "id, name, birth_date, birth_time, birth_place, birthtime_unknown, gender, notes, preferred_style, relationship, created_at";

  router.post("/heroes", async (req, res) => {
    const initData = req.body?.initData ?? req.headers["x-telegram-init"];
    const telegramUserId = validateInitData(initData, botToken);
    if (telegramUserId == null) return res.status(401).json({ error: "Неверные данные авторизации" });
    const appUser = await getOrCreateAppUser(supabase, telegramUserId);
    if (!appUser) return res.status(500).json({ error: "Ошибка профиля" });

    const { name, birth_date, birth_time, birth_place, birthtime_unknown, gender, notes, preferred_style, relationship } = req.body || {};
    if (!name || String(name).trim() === "") return res.status(400).json({ error: "Имя обязательно" });

    const row = {
      user_id: appUser.id,
      name: String(name).trim(),
      birth_date: birth_date || null,
      birth_time: birth_time || null,
      birth_place: birth_place ? String(birth_place).trim() : null,
      birthtime_unknown: !!birthtime_unknown,
      gender: gender || null,
      notes: notes != null ? String(notes).trim() : null,
      preferred_style: preferred_style ? String(preferred_style).trim() : null,
      relationship: relationship ? String(relationship).trim() : null,
    };

    const { data, error } = await supabase.from("clients").insert(row).select(HERO_SELECT).single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  });

  router.get("/heroes", async (req, res) => {
    const initData = req.query?.initData ?? req.headers["x-telegram-init"] ?? req.body?.initData;
    const telegramUserId = validateInitData(initData, botToken);
    if (telegramUserId == null) return res.status(401).json({ error: "Неверные данные авторизации" });
    const appUser = await getOrCreateAppUser(supabase, telegramUserId);
    if (!appUser) return res.status(500).json({ error: "Ошибка профиля" });

    let q = supabase.from("clients").select(HERO_SELECT).eq("user_id", appUser.id).order("created_at", { ascending: false });
    const search = req.query?.search;
    if (search && String(search).trim()) q = q.ilike("name", `%${String(search).trim()}%`);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ tariff: appUser.tariff, clients: data || [] });
  });

  router.patch("/heroes/:id", async (req, res) => {
    const initData = req.body?.initData ?? req.headers["x-telegram-init"];
    const telegramUserId = validateInitData(initData, botToken);
    if (telegramUserId == null) return res.status(401).json({ error: "Неверные данные авторизации" });
    const appUser = await getOrCreateAppUser(supabase, telegramUserId);
    if (!appUser) return res.status(500).json({ error: "Ошибка профиля" });

    const id = req.params.id;
    const updates = {};
    if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
    if (req.body?.birth_date !== undefined) updates.birth_date = req.body.birth_date || null;
    if (req.body?.birth_time !== undefined) updates.birth_time = req.body.birth_time || null;
    if (req.body?.birth_place !== undefined) updates.birth_place = req.body.birth_place ? String(req.body.birth_place).trim() : null;
    if (req.body?.birthtime_unknown !== undefined) updates.birthtime_unknown = !!req.body.birthtime_unknown;
    if (req.body?.gender !== undefined) updates.gender = req.body.gender || null;
    if (req.body?.notes !== undefined) updates.notes = req.body.notes != null ? String(req.body.notes).trim() : null;
    if (req.body?.preferred_style !== undefined) updates.preferred_style = req.body.preferred_style ? String(req.body.preferred_style).trim() : null;
    if (req.body?.relationship !== undefined) updates.relationship = req.body.relationship ? String(req.body.relationship).trim() : null;

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Нет полей для обновления" });
    if (updates.name !== undefined && updates.name === "") return res.status(400).json({ error: "Имя не может быть пустым" });

    const { data, error } = await supabase.from("clients").update(updates).eq("id", id).eq("user_id", appUser.id).select(HERO_SELECT).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Герой не найден" });
    return res.json(data);
  });

  // История генераций для конкретного героя — полные данные включая текст и анализ
  router.get("/heroes/:id/requests", async (req, res) => {
    const initData = req.query?.initData ?? req.headers["x-telegram-init"];
    const telegramUserId = validateInitData(initData, botToken);
    if (telegramUserId == null) return res.status(401).json({ error: "Неверные данные авторизации" });
    const appUser = await getOrCreateAppUser(supabase, telegramUserId);
    if (!appUser) return res.status(500).json({ error: "Ошибка профиля" });

    const heroId = req.params.id;
    const { data: hero } = await supabase.from("clients").select("id").eq("id", heroId).eq("user_id", appUser.id).maybeSingle();
    if (!hero) return res.status(404).json({ error: "Герой не найден" });

    const { data, error } = await supabase
      .from("track_requests")
      .select("id, title, lyrics, detailed_analysis, cover_letter, audio_url, generation_status, created_at, request_type, style_full, style_tags")
      .eq("client_id", heroId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error && /does not exist|relation/i.test(error.message)) return res.json({ requests: [] });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ requests: data || [] });
  });

  router.delete("/heroes/:id", async (req, res) => {
    const initData = req.body?.initData ?? req.query?.initData ?? req.headers["x-telegram-init"];
    const telegramUserId = validateInitData(initData, botToken);
    if (telegramUserId == null) return res.status(401).json({ error: "Неверные данные авторизации" });
    const appUser = await getOrCreateAppUser(supabase, telegramUserId);
    if (!appUser) return res.status(500).json({ error: "Ошибка профиля" });

    const { error } = await supabase.from("clients").delete().eq("id", req.params.id).eq("user_id", appUser.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(204).send();
  });

  return router;
}

export { createHeroesRouter, getOrCreateAppUser };
