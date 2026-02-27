/**
 * Геокодинг: место рождения (строка) → lat, lon.
 * Используется Nominatim (OpenStreetMap), без API-ключа.
 *
 * Стратегия (waterfall):
 *  1. Запрос «как есть»
 *  2. Нормализованный адрес (убрать префиксы нас.пунктов, привести падеж региона)
 *  3. Укороченный — «город/нас.пункт, страна»
 *  4. Только название нас.пункта (без региона)
 *  5. Транслитерация «Название, Russia» для Nominatim
 *  6. Известные кириллические алиасы (Киев → Kyiv, и т.д.)
 *  7. Только регион в именительном падеже (для совсем неизвестных сёл)
 *  8. Last-resort: если регион — Россия, вернуть центр России; иначе — null
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// ─── Алиасы кириллических городов → Nominatim-запрос ───────────────────────
const BIRTHPLACE_ALIASES = [
  [/^\s*Киев\s*,\s*Украин[ае]\s*$/i,           "Kyiv, Ukraine"],
  [/^\s*Київ\s*,\s*Україн[аи]\s*$/i,            "Kyiv, Ukraine"],
  [/^\s*Киев\s*$/i,                               "Kyiv, Ukraine"],
  [/^\s*Київ\s*$/i,                               "Kyiv, Ukraine"],
  [/^\s*Одесс?[аы]\s*,\s*Украин[ае]\s*$/i,      "Odesa, Ukraine"],
  [/^\s*Харь?к[іи]в\s*,\s*Украин[ае]\s*$/i,     "Kharkiv, Ukraine"],
  [/^\s*Львов\s*,\s*Украин[ае]\s*$/i,             "Lviv, Ukraine"],
  [/^\s*Львів\s*,\s*Україн[аи]\s*$/i,             "Lviv, Ukraine"],
  [/^\s*Дніпр[оа]\s*,\s*Украин[ае]\s*$/i,        "Dnipro, Ukraine"],
  [/^\s*Днепр\s*,\s*Украин[ае]\s*$/i,             "Dnipro, Ukraine"],
];

function aliasForNominatim(s) {
  for (const [re, latin] of BIRTHPLACE_ALIASES) {
    if (re.test(s)) return latin;
  }
  return null;
}

// ─── Префиксы типов населённых пунктов (для удаления из начала строки) ──────
const SETTLEMENT_PREFIXES = [
  /^станица\s+/i,
  /^ст\.\s*/i,
  /^деревня\s+/i,
  /^дер\.\s*/i,
  /^д\.\s*/i,
  /^село\s+/i,
  /^с\.\s*/i,
  /^хутор\s+/i,
  /^х\.\s*/i,
  /^посёлок\s+/i,
  /^поселок\s+/i,
  /^пос\.\s*/i,
  /^п\.\s*/i,
  /^рп\s+/i,
  /^р\.п\.\s*/i,
  /^рабочий\s+посёлок\s+/i,
  /^пгт\s+/i,
  /^аул\s+/i,
  /^а\.\s*/i,
  /^слобода\s+/i,
  /^местечко\s+/i,
  /^городской\s+округ\s+/i,
  /^муниципальный\s+округ\s+/i,
  /^городское\s+поселение\s+/i,
  /^г\.\s*/i,
  /^город\s+/i,
];

/**
 * Убирает тип населённого пункта и суффикс "район" из строки.
 */
function extractCityName(raw) {
  let s = String(raw || "").trim();
  if (!s) return s;
  for (const re of SETTLEMENT_PREFIXES) {
    const trimmed = s.replace(re, "").trim();
    if (trimmed && trimmed !== s) { s = trimmed; break; }
  }
  s = s.replace(/\s+район\s*$/i, "").trim();
  return s || raw;
}

// ─── Нормализация родительного падежа регионов → именительный ───────────────
// "Краснодарского края" → "Краснодарский край"
// "Ростовской области" → "Ростовская область"
// "Республики Башкортостан" → "Республика Башкортостан"
// "города Москвы" → "Москва"
const GENITIVE_REGION_RULES = [
  [/\bРеспублики\s+(\S+)/gi,              "Республика $1"],
  [/\bгорода\s+(\S+)/gi,                  "$1"],
  [/\b(\S+)ского\s+края\b/gi,             "$1ский край"],
  [/\b(\S+)ского\s+района\b/gi,           "$1ский район"],
  [/\b(\S+)ского\s+округа\b/gi,           "$1ский округ"],
  [/\b(\S+)цкого\s+края\b/gi,             "$1цкий край"],
  [/\b(\S+)цкого\s+района\b/gi,           "$1цкий район"],
  [/\b(\S+)ской\s+области\b/gi,           "$1ская область"],
  [/\b(\S+)ской\s+республики\b/gi,        "$1ская республика"],
  [/\b(\S+)ной\s+области\b/gi,            "$1ная область"],
  [/\b(\S+)ной\s+республики\b/gi,         "$1ная республика"],
  [/\b(\S+)ого\s+края\b/gi,               "$1ый край"],
  [/\b(\S+)ого\s+района\b/gi,             "$1ый район"],
  [/\b(\S+)ого\s+округа\b/gi,             "$1ый округ"],
  [/\b(\S+)ой\s+области\b/gi,             "$1ая область"],
  [/\b(\S+)ей\s+области\b/gi,             "$1ь область"],
];

function normalizeGenitiveCase(s) {
  let result = s;
  for (const [re, repl] of GENITIVE_REGION_RULES) {
    result = result.replace(re, repl);
  }
  return result;
}

/**
 * Нормализует полный адрес:
 * — убирает префиксы типа нас.пункта в каждой части
 * — приводит родительный падеж региона к именительному
 */
function normalizeAddress(fullAddress) {
  const s = String(fullAddress || "").trim();
  if (!s) return s;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return s;
  const normalized = parts.map((p, i) => {
    // Первая часть — название нас.пункта: убираем тип
    if (i === 0) return extractCityName(p);
    // Остальные части — могут содержать регион в родит.падеже
    return normalizeGenitiveCase(p);
  });
  const result = normalized.filter(Boolean).join(", ");
  return result !== s ? result : s;
}

/**
 * Строит укороченный запрос "нас.пункт, страна".
 */
function shortenForFallback(fullAddress) {
  const s = String(fullAddress || "").trim();
  if (!s) return null;
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const city = extractCityName(parts[0]);
  if (!city) return null;
  const hasRussia = /россия|russia|рф\b/i.test(s);
  const country = hasRussia ? "Россия" : (parts.length > 1 ? parts[parts.length - 1] : "Россия");
  if (city.toLowerCase() === country.toLowerCase()) return city;
  return `${city}, ${country}`;
}

// ─── Транслитерация кириллица → латиница ────────────────────────────────────
const RU_LAT = {
  а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",
  и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",
  с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"shch",
  ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya",
};
function transliterate(text) {
  if (!text) return "";
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase();
    if (RU_LAT[c] !== undefined) {
      const lat = RU_LAT[c];
      const isUpper = text[i] !== text[i].toLowerCase();
      out += isUpper && lat ? lat[0].toUpperCase() + lat.slice(1) : lat;
    } else {
      out += text[i];
    }
  }
  return out;
}

/** Для "Город, Россия" → "Gorod, Russia" (Nominatim лучше ищет по-латински). */
function toLatinRussiaQuery(q) {
  const s = String(q || "").trim();
  if (!s || !/россия/i.test(s)) return null;
  const idx = s.lastIndexOf(",");
  const city = (idx >= 0 ? s.slice(0, idx).trim() : s);
  if (!city) return null;
  const lat = transliterate(city);
  if (!lat) return null;
  return lat[0].toUpperCase() + lat.slice(1).toLowerCase() + ", Russia";
}

// ─── Регионы России: приближённые координаты для last-resort fallback ─────────
// Если распознали регион, но не нашли само место — используем центр региона.
const RUSSIA_REGIONS_COORDS = {
  "краснодарский":   { lat: 45.04, lon: 38.98 },
  "ростовская":      { lat: 47.22, lon: 39.71 },
  "московская":      { lat: 55.75, lon: 37.62 },
  "ленинградская":   { lat: 59.94, lon: 30.31 },
  "свердловская":    { lat: 56.84, lon: 60.60 },
  "нижегородская":   { lat: 56.33, lon: 44.00 },
  "самарская":       { lat: 53.20, lon: 50.15 },
  "воронежская":     { lat: 51.67, lon: 39.18 },
  "саратовская":     { lat: 51.53, lon: 46.03 },
  "волгоградская":   { lat: 48.71, lon: 44.51 },
  "пермский":        { lat: 58.01, lon: 56.23 },
  "красноярский":    { lat: 56.01, lon: 92.87 },
  "иркутская":       { lat: 52.29, lon: 104.30 },
  "новосибирская":   { lat: 54.99, lon: 82.90 },
  "омская":          { lat: 54.99, lon: 73.37 },
  "челябинская":     { lat: 55.16, lon: 61.40 },
  "тюменская":       { lat: 57.15, lon: 68.00 },
  "алтайский":       { lat: 53.35, lon: 83.75 },
  "ставропольский":  { lat: 45.05, lon: 41.97 },
  "белгородская":    { lat: 50.60, lon: 36.59 },
  "тульская":        { lat: 54.20, lon: 37.62 },
  "калужская":       { lat: 54.51, lon: 36.26 },
  "брянская":        { lat: 53.25, lon: 34.37 },
  "курская":         { lat: 51.73, lon: 36.19 },
  "орловская":       { lat: 52.97, lon: 36.07 },
  "липецкая":        { lat: 52.60, lon: 39.57 },
  "тамбовская":      { lat: 52.72, lon: 41.45 },
  "пензенская":      { lat: 53.20, lon: 45.01 },
  "ульяновская":     { lat: 54.32, lon: 48.38 },
  "оренбургская":    { lat: 51.77, lon: 55.10 },
  "башкортостан":    { lat: 54.74, lon: 55.97 },
  "татарстан":       { lat: 55.78, lon: 49.12 },
  "кировская":       { lat: 58.60, lon: 49.65 },
  "удмуртская":      { lat: 56.84, lon: 53.20 },
  "чувашская":       { lat: 56.14, lon: 47.25 },
  "мордовия":        { lat: 54.44, lon: 44.56 },
  "марий":           { lat: 56.63, lon: 47.89 },
  "чечня":           { lat: 43.32, lon: 45.70 },
  "дагестан":        { lat: 42.97, lon: 47.50 },
  "кабардино":       { lat: 43.51, lon: 43.40 },
  "северная осетия": { lat: 43.05, lon: 44.67 },
  "ингушетия":       { lat: 43.12, lon: 44.82 },
  "адыгея":          { lat: 44.61, lon: 40.10 },
  "карачаево":       { lat: 43.73, lon: 41.74 },
  "калмыкия":        { lat: 46.31, lon: 44.26 },
  "астраханская":    { lat: 46.35, lon: 48.04 },
  "мурманская":      { lat: 68.97, lon: 33.07 },
  "архангельская":   { lat: 64.54, lon: 40.54 },
  "вологодская":     { lat: 59.22, lon: 39.88 },
  "ярославская":     { lat: 57.63, lon: 39.87 },
  "костромская":     { lat: 57.77, lon: 40.93 },
  "ивановская":      { lat: 57.00, lon: 40.97 },
  "владимирская":    { lat: 56.13, lon: 40.41 },
  "рязанская":       { lat: 54.63, lon: 39.74 },
  "смоленская":      { lat: 54.78, lon: 32.04 },
  "тверская":        { lat: 56.86, lon: 35.90 },
  "псковская":       { lat: 57.82, lon: 28.33 },
  "новгородская":    { lat: 58.53, lon: 31.27 },
  "карелия":         { lat: 61.79, lon: 34.36 },
  "коми":            { lat: 61.68, lon: 50.84 },
  "якутия":          { lat: 62.03, lon: 129.73 },
  "забайкальский":   { lat: 51.53, lon: 113.50 },
  "хабаровский":     { lat: 48.48, lon: 135.07 },
  "приморский":      { lat: 43.11, lon: 131.87 },
  "амурская":        { lat: 50.29, lon: 127.53 },
  "сахалинская":     { lat: 46.96, lon: 142.73 },
  "камчатский":      { lat: 53.01, lon: 158.65 },
  "магаданская":     { lat: 59.57, lon: 150.79 },
  "калининградская": { lat: 54.71, lon: 20.50 },
  "крым":            { lat: 45.35, lon: 34.10 },
};

/** Находит приближённые координаты по названию региона в адресе. */
function guessRegionCoords(fullAddress) {
  const s = normalizeGenitiveCase(String(fullAddress || "").toLowerCase());
  for (const [key, coords] of Object.entries(RUSSIA_REGIONS_COORDS)) {
    if (s.includes(key)) return coords;
  }
  // Для любого адреса в России → центр России
  if (/россия|russia|рф\b/i.test(fullAddress)) {
    return { lat: 55.75, lon: 37.62 }; // Москва как центральный fallback
  }
  // Для любого адреса в Беларуси → центр Беларуси (Минск) как мягкий fallback
  if (/беларусь|belarus|белорусси(я|и)/i.test(fullAddress)) {
    return { lat: 53.9, lon: 27.5667 };
  }
  return null;
}

// ─── Основной fetch к Nominatim ─────────────────────────────────────────────
async function fetchOne(query) {
  const params = new URLSearchParams({ q: query, format: "json", limit: "1" });
  try {
    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { "User-Agent": "YupSoulBot/1.0 (astro birth place)" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : null;
    if (!first || first.lat == null || first.lon == null) return null;
    return { lat: Number(first.lat), lon: Number(first.lon), display_name: first.display_name };
  } catch (e) {
    console.warn("[geocode] fetchOne error:", e?.message);
    return null;
  }
}

const DELAY = 1100; // Nominatim policy: 1 req/sec
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} birthplace
 * @returns {Promise<{ lat: number, lon: number, display_name?: string, approximate?: boolean } | null>}
 */
export async function geocode(birthplace) {
  const q = String(birthplace || "").trim();
  if (!q) return null;

  const tried = new Set();
  async function tryQuery(label, query) {
    if (!query || tried.has(query)) return null;
    tried.add(query);
    console.log(`[geocode] [${label}] "${query}"`);
    const r = await fetchOne(query);
    if (r) console.log(`[geocode] [${label}] OK: ${r.lat},${r.lon}`);
    return r;
  }

  try {
    // 1. Оригинал
    let result = await tryQuery("original", q);
    if (result) return result;

    // 2. Нормализованный адрес (убрать префиксы, исправить падеж)
    const normalized = normalizeAddress(q);
    if (normalized !== q) {
      await sleep(DELAY);
      result = await tryQuery("normalized", normalized);
      if (result) return result;
    }

    // 3. Укороченный: «нас.пункт, страна»
    const short = shortenForFallback(q);
    if (short) {
      await sleep(DELAY);
      result = await tryQuery("short", short);
      if (result) return result;

      // 3а. Алиас (Киев → Kyiv и т.д.)
      const alias = aliasForNominatim(short);
      if (alias) {
        await sleep(DELAY);
        result = await tryQuery("alias", alias);
        if (result) return result;
      }

      // 3б. Транслитерация для российских городов
      const latinRu = toLatinRussiaQuery(short);
      if (latinRu) {
        await sleep(DELAY);
        result = await tryQuery("latin-ru", latinRu);
        if (result) return result;
      }
    }

    // 4. Только название нас.пункта (без региона и страны)
    const parts = q.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const justCity = extractCityName(parts[0]);
      if (justCity && justCity !== q) {
        await sleep(DELAY);
        result = await tryQuery("city-only", justCity);
        if (result) return result;

        // 4а. Транслитерация просто города + Russia
        const latinCity = toLatinRussiaQuery(`${justCity}, Россия`);
        if (latinCity) {
          await sleep(DELAY);
          result = await tryQuery("city-latin", latinCity);
          if (result) return result;
        }
      }
    }

    // 5. Алиас для оригинала
    const origAlias = aliasForNominatim(q);
    if (origAlias) {
      await sleep(DELAY);
      result = await tryQuery("orig-alias", origAlias);
      if (result) return result;
    }

    // 6. Попытка нормализованного — только нас.пункт из нормализованной версии
    if (normalized !== q) {
      const normParts = normalized.split(",").map((p) => p.trim()).filter(Boolean);
      if (normParts.length > 0) {
        const normCity = normParts[0];
        if (normCity !== q && normCity !== (parts[0] || "")) {
          const latinNorm = toLatinRussiaQuery(`${normCity}, Россия`);
          if (latinNorm) {
            await sleep(DELAY);
            result = await tryQuery("norm-city-latin", latinNorm);
            if (result) return result;
          }
        }
      }
    }

    // 7. Last-resort: приближённые координаты по региону
    const approxCoords = guessRegionCoords(q);
    if (approxCoords) {
      console.warn(`[geocode] Не найдено точно — используем приближённые координаты для "${q}": ${approxCoords.lat},${approxCoords.lon}`);
      return { ...approxCoords, approximate: true, display_name: q };
    }

    console.warn(`[geocode] Геокодинг полностью не удался для: "${q}"`);
    return null;
  } catch (err) {
    console.error("[geocode] unexpected error:", err.message);
    return null;
  }
}
