/**
 * Геокодинг: место рождения (строка) → lat, lon.
 * Используется Nominatim (OpenStreetMap), без API-ключа.
 * Для длинных адресов (display_name из подсказок) делаем fallback на "город, страна".
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/**
 * Выполняет один запрос к Nominatim.
 * @param {string} query
 * @returns {Promise<{ lat: number, lon: number, display_name?: string } | null>}
 */
async function fetchOne(query) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "1",
  });
  const url = `${NOMINATIM_URL}?${params}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "YupSoulBot/1.0 (astro birth place)" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  if (!first || first.lat == null || first.lon == null) return null;
  return {
    lat: Number(first.lat),
    lon: Number(first.lon),
    display_name: first.display_name,
  };
}

/**
 * Строит укороченный запрос для fallback: первый элемент адреса + страна.
 * Например: "Омск, городской округ Омск, Омская область, ..." → "Омск, Россия"
 */
function shortenForFallback(fullAddress) {
  const s = String(fullAddress || "").trim();
  if (!s) return null;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const city = parts[0];
  if (!city) return null;
  const hasRussia = /россия|russia|рф|ru\b/i.test(s);
  const country = hasRussia ? "Россия" : (parts.length > 1 ? parts[parts.length - 1] : "Россия");
  if (city === country) return city;
  return `${city}, ${country}`;
}

/**
 * @param {string} birthplace — например "Москва, Россия" или "Омск, городской округ Омск, Омская область, ..."
 * @returns {Promise<{ lat: number, lon: number, display_name?: string } | null>}
 */
export async function geocode(birthplace) {
  const q = String(birthplace || "").trim();
  if (!q) return null;

  try {
    let result = await fetchOne(q);
    if (result) return result;
    const fallbackQuery = shortenForFallback(q);
    if (fallbackQuery && fallbackQuery !== q) {
      await new Promise((r) => setTimeout(r, 1100));
      result = await fetchOne(fallbackQuery);
      if (result) return result;
    }
    return null;
  } catch (err) {
    console.error("[geocode]", err.message);
    return null;
  }
}
