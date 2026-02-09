/**
 * Воркер: расчёт натальной карты по заявке и сохранение в astro_snapshots.
 * Вызывается из воркера генерации после геокодинга.
 */

import { geocode } from "./geocode.js";
import { getAstroSnapshot } from "./astroLib.js";

/**
 * Парсит birthdate "YYYY-MM-DD" и birthtime "HH:MM" или "HH:MM:SS".
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number } | null}
 */
function parseBirthDateTime(birthdate, birthtime, timeUnknown) {
  if (!birthdate) return null;
  const m = String(birthdate).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  let hour = 12;
  let minute = 0;
  if (!timeUnknown && birthtime) {
    const t = String(birthtime).trim().match(/^(\d{1,2}):(\d{2})/);
    if (t) {
      hour = parseInt(t[1], 10);
      minute = parseInt(t[2], 10);
    }
  }
  return { year, month, day, hour, minute };
}

/**
 * По заявке: геокодинг → расчёт AstroSnapshot → сохранение в astro_snapshots, привязка к track_requests.
 * @param {object} supabase — клиент Supabase (service role)
 * @param {string} trackRequestId — uuid заявки
 * @returns {{ ok: boolean, astro_snapshot_id?: string, error?: string }}
 */
export async function computeAndSaveAstroSnapshot(supabase, trackRequestId) {
  if (!supabase || !trackRequestId) {
    return { ok: false, error: "supabase и trackRequestId обязательны" };
  }

  const { data: req, error: fetchErr } = await supabase
    .from("track_requests")
    .select("id, birthdate, birthplace, birthtime, birthtime_unknown")
    .eq("id", trackRequestId)
    .single();

  if (fetchErr || !req) {
    return { ok: false, error: fetchErr?.message || "Заявка не найдена" };
  }

  const coords = await geocode(req.birthplace || "");
  if (!coords) {
    return { ok: false, error: "Не удалось определить координаты места рождения: " + (req.birthplace || "") };
  }

  const dt = parseBirthDateTime(req.birthdate, req.birthtime, req.birthtime_unknown);
  if (!dt) {
    return { ok: false, error: "Некорректная дата рождения: " + req.birthdate };
  }

  const snapshot = getAstroSnapshot({
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    latitude: coords.lat,
    longitude: coords.lon,
    timeUnknown: !!req.birthtime_unknown,
  });

  if (snapshot.error) {
    return { ok: false, error: snapshot.error };
  }

  const birthUtc = req.birthdate && (req.birthtime || req.birthtime_unknown)
    ? new Date(`${req.birthdate}T${req.birthtime || "12:00"}Z`).toISOString()
    : null;

  const { data: inserted, error: insertErr } = await supabase
    .from("astro_snapshots")
    .insert({
      track_request_id: trackRequestId,
      snapshot_text: snapshot.snapshot_text,
      snapshot_json: snapshot.snapshot_json,
      birth_lat: coords.lat,
      birth_lon: coords.lon,
      birth_utc: birthUtc,
      time_unknown: !!req.birthtime_unknown,
    })
    .select("id")
    .single();

  if (insertErr) {
    return { ok: false, error: "Ошибка сохранения снапшота: " + insertErr.message };
  }

  await supabase
    .from("track_requests")
    .update({ astro_snapshot_id: inserted.id, updated_at: new Date().toISOString() })
    .eq("id", trackRequestId);

  return { ok: true, astro_snapshot_id: inserted.id };
}
