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
 * @param {{ lat?: number, lon?: number } | null} providedCoords — опциональные координаты (если уже известны)
 * @returns {{ ok: boolean, astro_snapshot_id?: string, error?: string }}
 */
export async function computeAndSaveAstroSnapshot(supabase, trackRequestId, providedCoords = null) {
  if (!supabase || !trackRequestId) {
    return { ok: false, error: "supabase и trackRequestId обязательны" };
  }

  const { data: req, error: fetchErr } = await supabase
    .from("track_requests")
    .select("id, mode, birthdate, birthplace, birthtime, birthtime_unknown, birthplace_lat, birthplace_lon, person2_name, person2_birthdate, person2_birthplace, person2_birthtime, person2_birthtime_unknown")
    .eq("id", trackRequestId)
    .single();

  if (fetchErr || !req) {
    return { ok: false, error: fetchErr?.message || "Заявка не найдена" };
  }

  // Используем координаты: переданные → из заявки (Mini App) → геокодинг
  let coords = null;
  if (providedCoords && typeof providedCoords.lat === 'number' && typeof providedCoords.lon === 'number') {
    coords = { lat: providedCoords.lat, lon: providedCoords.lon };
    console.log("[workerAstro] Используем переданные координаты:", coords);
  } else if (req.birthplace_lat != null && req.birthplace_lon != null) {
    coords = { lat: Number(req.birthplace_lat), lon: Number(req.birthplace_lon) };
    console.log("[workerAstro] Координаты из заявки (Mini App):", coords);
  } else {
    coords = await geocode(req.birthplace || "");
    if (!coords) {
      return { ok: false, error: "Не удалось определить координаты места рождения: " + (req.birthplace || "") };
    }
    console.log("[workerAstro] Координаты получены через геокодинг:", coords);
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

  let snapshotJsonToSave = snapshot.snapshot_json;
  if (req.mode === "couple" && req.person2_name && req.person2_birthdate && req.person2_birthplace) {
    const coords2 = await geocode(req.person2_birthplace || "");
    const dt2 = parseBirthDateTime(req.person2_birthdate, req.person2_birthtime, req.person2_birthtime_unknown);
    if (coords2 && dt2) {
      const snapshot2 = getAstroSnapshot({
        year: dt2.year,
        month: dt2.month,
        day: dt2.day,
        hour: dt2.hour,
        minute: dt2.minute,
        latitude: coords2.lat,
        longitude: coords2.lon,
        timeUnknown: !!req.person2_birthtime_unknown,
      });
      if (!snapshot2.error) {
        snapshotJsonToSave = {
          ...snapshot.snapshot_json,
          person1_snapshot: {
            snapshot_text: snapshot.snapshot_text,
            snapshot_json: snapshot.snapshot_json,
          },
          person2_snapshot: {
            snapshot_text: snapshot2.snapshot_text,
            snapshot_json: snapshot2.snapshot_json,
          },
        };
      }
    }
  }

  const birthUtc = req.birthdate && (req.birthtime || req.birthtime_unknown)
    ? new Date(`${req.birthdate}T${req.birthtime || "12:00"}Z`).toISOString()
    : null;

  const { data: inserted, error: insertErr } = await supabase
    .from("astro_snapshots")
    .insert({
      track_request_id: trackRequestId,
      snapshot_text: snapshot.snapshot_text,
      snapshot_json: snapshotJsonToSave,
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
