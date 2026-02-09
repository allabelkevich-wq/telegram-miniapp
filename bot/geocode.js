/**
 * Геокодинг: место рождения (строка) → lat, lon.
 * Используется Nominatim (OpenStreetMap), без API-ключа.
 * Для времени «полдень по месту» в будущем можно добавить timezone по lat/lon.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/**
 * @param {string} birthplace — например "Москва, Россия" или "London, UK"
 * @returns {Promise<{ lat: number, lon: number, display_name?: string } | null>}
 */
export async function geocode(birthplace) {
  const q = String(birthplace || "").trim();
  if (!q) return null;

  const params = new URLSearchParams({
    q,
    format: "json",
    limit: "1",
  });
  const url = `${NOMINATIM_URL}?${params}`;

  try {
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
  } catch (err) {
    console.error("[geocode]", err.message);
    return null;
  }
}
