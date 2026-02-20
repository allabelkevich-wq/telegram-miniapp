/**
 * Геокодинг: место рождения (строка) → lat, lon.
 * Используется Nominatim (OpenStreetMap), без API-ключа.
 * Для длинных адресов (display_name из подсказок) делаем fallback на "город, страна".
 * Для кириллических названий пробуем латинские варианты (Nominatim лучше находит "Kyiv, Ukraine").
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/** Алиасы "строка пользователя" → запрос для Nominatim (латинский вариант). */
const BIRTHPLACE_ALIASES = [
  [/^\s*Киев\s*,\s*Украина\s*$/i, "Kyiv, Ukraine"],
  [/^\s*Київ\s*,\s*Україна\s*$/i, "Kyiv, Ukraine"],
  [/^\s*Киев\s*,\s*Україна\s*$/i, "Kyiv, Ukraine"],
  [/^\s*Київ\s*,\s*Украина\s*$/i, "Kyiv, Ukraine"],
  [/^\s*Киев\s*$/i, "Kyiv, Ukraine"],
  [/^\s*Київ\s*$/i, "Kyiv, Ukraine"],
  [/^\s*Одесса\s*,\s*Украина\s*$/i, "Odesa, Ukraine"],
  [/^\s*Одеса\s*,\s*Україна\s*$/i, "Odesa, Ukraine"],
  [/^\s*Харьков\s*,\s*Украина\s*$/i, "Kharkiv, Ukraine"],
  [/^\s*Харків\s*,\s*Україна\s*$/i, "Kharkiv, Ukraine"],
  [/^\s*Львов\s*,\s*Украина\s*$/i, "Lviv, Ukraine"],
  [/^\s*Львів\s*,\s*Україна\s*$/i, "Lviv, Ukraine"],
  [/^\s*Днепр\s*,\s*Украина\s*$/i, "Dnipro, Ukraine"],
  [/^\s*Дніпро\s*,\s*Україна\s*$/i, "Dnipro, Ukraine"],
];

function aliasForNominatim(birthplace) {
  const s = String(birthplace || "").trim();
  for (const [re, latin] of BIRTHPLACE_ALIASES) {
    if (re.test(s)) return latin;
  }
  return null;
}

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
 * Из первой части адреса извлекает название города, убирая префиксы вроде "городской округ", "г.", "город".
 * "городской округ Новочеркасск" → "Новочеркасск", "г. Москва" → "Москва".
 */
function extractCityName(firstPart) {
  const raw = String(firstPart || "").trim();
  if (!raw) return raw;
  const normalized = raw
    .replace(/^городской\s+округ\s+/i, "")
    .replace(/^муниципальный\s+округ\s+/i, "")
    .replace(/^городское\s+поселение\s+/i, "")
    .replace(/^г\.\s*/i, "")
    .replace(/^город\s+/i, "")
    .replace(/\s+район\s*$/i, "")
    .trim();
  return normalized || raw;
}

/**
 * Строит укороченный запрос для fallback: город (из первого элемента) + страна.
 * Например: "городской округ Новочеркасск, Ростовская область, Россия" → "Новочеркасск, Россия"
 */
function shortenForFallback(fullAddress) {
  const s = String(fullAddress || "").trim();
  if (!s) return null;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const cityRaw = parts[0];
  if (!cityRaw) return null;
  const city = extractCityName(cityRaw);
  const hasRussia = /россия|russia|рф|ru\b/i.test(s);
  const country = hasRussia ? "Россия" : (parts.length > 1 ? parts[parts.length - 1] : "Россия");
  if (city === country) return city;
  return `${city}, ${country}`;
}

/** Транслитерация кириллицы → латиница (схема для геопоиска: BGN-подобная). */
const RU_LAT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
function transliterateRuToEn(text) {
  if (!text || typeof text !== "string") return "";
  let out = "";
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    if (RU_LAT[c] !== undefined) {
      const lat = RU_LAT[c];
      const isUpper = /[а-яё]/i.test(text[i]) && text[i] === text[i].toUpperCase();
      out += isUpper && lat ? lat.charAt(0).toUpperCase() + lat.slice(1) : lat;
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * Для запроса вида "Город, Россия" возвращает "Gorod, Russia" (латиница).
 * Nominatim часто лучше находит российские города в латинской форме.
 */
function toLatinRussiaQuery(shortQuery) {
  const s = String(shortQuery || "").trim();
  if (!s) return null;
  if (!/россия/i.test(s)) return null;
  const idx = s.lastIndexOf(",");
  const city = (idx >= 0 ? s.slice(0, idx).trim() : s);
  if (!city) return null;
  const latin = transliterateRuToEn(city);
  if (!latin) return null;
  const cityCapitalized = latin.charAt(0).toUpperCase() + latin.slice(1).toLowerCase();
  return cityCapitalized + ", Russia";
}

/**
 * @param {string} birthplace — например "Москва, Россия" или "Омск, городской округ Омск, Омская область, ..."
 * @returns {Promise<{ lat: number, lon: number, display_name?: string } | null>}
 */
export async function geocode(birthplace) {
  const q = String(birthplace || "").trim();
  if (!q) return null;

  try {
    // Сначала пробуем запрос как есть
    let result = await fetchOne(q);
    if (result) return result;

    // Кириллические названия (Киев, Украина и т.д.) — пробуем латинский вариант для Nominatim
    const alias = aliasForNominatim(q);
    if (alias && alias !== q) {
      await new Promise((r) => setTimeout(r, 1100));
      result = await fetchOne(alias);
      if (result) return result;
    }

    // Длинные адреса — укороченный запрос "город, страна"
    const fallbackQuery = shortenForFallback(q);
    if (fallbackQuery && fallbackQuery !== q) {
      await new Promise((r) => setTimeout(r, 1100));
      result = await fetchOne(fallbackQuery);
      if (result) return result;
      // Укороченный не сработал — для укороченного тоже пробуем алиас (например "Киев, Украина" → "Kyiv, Ukraine")
      const fallbackAlias = aliasForNominatim(fallbackQuery);
      if (fallbackAlias) {
        await new Promise((r) => setTimeout(r, 1100));
        result = await fetchOne(fallbackAlias);
        if (result) return result;
      }
      // Для "Город, Россия" пробуем латинский вариант (Nominatim лучше находит "Kurganinsk, Russia")
      const latinRussia = toLatinRussiaQuery(fallbackQuery);
      if (latinRussia && latinRussia !== fallbackQuery) {
        await new Promise((r) => setTimeout(r, 1100));
        result = await fetchOne(latinRussia);
        if (result) return result;
      }
    }

    return null;
  } catch (err) {
    console.error("[geocode]", err.message);
    return null;
  }
}
