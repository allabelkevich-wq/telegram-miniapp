/**
 * astroLib — ведический/сидерический расчёт для анализа «МОЯ ДУША».
 * Система: Sidereal (Lahiri), дома Whole Sign.
 * Включает: накшатры/пады, аспекты (в т.ч. квинтиль, биквинтиль), Лилит, Хирон, Вертекс, Парс Фортуны,
 * чара-караки, арудха-лагна.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const swisseph = require("swisseph");

const SIGNS_RU = [
  "Овен", "Телец", "Близнецы", "Рак", "Лев", "Дева",
  "Весы", "Скорпион", "Стрелец", "Козерог", "Водолей", "Рыбы"
];

// 27 накшатр: имя, божество, цель (Дхарма/Артха/Кама/Мокша)
const NAKSHATRAS_27 = [
  { name: "Ашвини", deity: "Ашвины", goal: "Дхарма" },
  { name: "Бхарани", deity: "Яма", goal: "Дхарма" },
  { name: "Криттика", deity: "Агни", goal: "Дхарма" },
  { name: "Рохини", deity: "Брахма", goal: "Дхарма" },
  { name: "Мригашира", deity: "Сома", goal: "Дхарма" },
  { name: "Ардра", deity: "Рудра", goal: "Дхарма" },
  { name: "Пунарвасу", deity: "Адити", goal: "Дхарма" },
  { name: "Пушья", deity: "Брихаспати", goal: "Дхарма" },
  { name: "Ашлеша", deity: "Наги", goal: "Дхарма" },
  { name: "Магха", deity: "Питры", goal: "Артха" },
  { name: "Пурва Пхалгуни", deity: "Бхага", goal: "Артха" },
  { name: "Уттара Пхалгуни", deity: "Арьяман", goal: "Артха" },
  { name: "Хаста", deity: "Савейтри/Сурья", goal: "Артха" },
  { name: "Читра", deity: "Тваштри/Вишвакарман", goal: "Артха" },
  { name: "Свати", deity: "Вайю", goal: "Артха" },
  { name: "Вишакха", deity: "Индра и Агни", goal: "Артха" },
  { name: "Анурадха", deity: "Митра", goal: "Артха" },
  { name: "Джьештха", deity: "Индра", goal: "Артха" },
  { name: "Мула", deity: "Ниритти", goal: "Кама" },
  { name: "Пурва Ашадха", deity: "Апах", goal: "Кама" },
  { name: "Уттара Ашадха", deity: "Вишведевы", goal: "Кама" },
  { name: "Шравана", deity: "Вишну", goal: "Кама" },
  { name: "Дхаништха", deity: "Восемь Васу", goal: "Кама" },
  { name: "Шатабиша", deity: "Варуна", goal: "Кама" },
  { name: "Пурва Бхадрапада", deity: "Аджикапада", goal: "Мокша" },
  { name: "Уттара Бхадрапада", deity: "Ахир Будхьяна", goal: "Мокша" },
  { name: "Ревати", deity: "Пушан", goal: "Мокша" },
];

const NAKSHATRA_DEG = 360 / 27;
const PADA_DEG = NAKSHATRA_DEG / 4;

// Планеты для основной карты + дополнительные точки
const PLANETS = [
  { id: swisseph.SE_SUN, name: "Солнце" },
  { id: swisseph.SE_MOON, name: "Луна" },
  { id: swisseph.SE_MERCURY, name: "Меркурий" },
  { id: swisseph.SE_VENUS, name: "Венера" },
  { id: swisseph.SE_MARS, name: "Марс" },
  { id: swisseph.SE_JUPITER, name: "Юпитер" },
  { id: swisseph.SE_SATURN, name: "Сатурн" },
  { id: swisseph.SE_URANUS, name: "Уран" },
  { id: swisseph.SE_NEPTUNE, name: "Нептун" },
  { id: swisseph.SE_PLUTO, name: "Плутон" },
  { id: swisseph.SE_TRUE_NODE, name: "Северный узел" },
];

const EXTRA_POINTS = [
  { id: swisseph.SE_MEAN_APOG, name: "Лилит (Чёрная Луна)" },
  { id: swisseph.SE_CHIRON, name: "Хирон" },
];

// Аспекты: мажорные + квинтиль, биквинтиль, минорные
const ASPECTS = [
  { angle: 0, name: "соединение", orb: 8 },
  { angle: 30, name: "полусекстиль", orb: 2 },
  { angle: 45, name: "полуквадрат", orb: 2 },
  { angle: 60, name: "секстиль", orb: 6 },
  { angle: 72, name: "квинтиль", orb: 2 },
  { angle: 90, name: "квадрат", orb: 8 },
  { angle: 120, name: "трин", orb: 8 },
  { angle: 135, name: "сесквиквадрат", orb: 2 },
  { angle: 144, name: "биквинтиль", orb: 2 },
  { angle: 150, name: "квиконс", orb: 2 },
  { angle: 180, name: "оппозиция", orb: 8 },
];

// Знак → управитель (для арудх): индекс планеты Sun=0..Saturn=6
// Управитель знака по индексу 0..11: имя планеты
const SIGN_LORD_NAMES = ["Марс", "Венера", "Меркурий", "Луна", "Солнце", "Меркурий", "Венера", "Марс", "Юпитер", "Сатурн", "Сатурн", "Юпитер"];

const CHARA_KARAKA_NAMES = ["Атмакарака", "Аматьякарака", "Бхратрикарака", "Матрикарака", "Питрикарака", "Гьянакарака", "Дааракарака"];

function norm360(lon) {
  let x = lon % 360;
  if (x < 0) x += 360;
  return x;
}

function lonToSignDegree(lon) {
  const L = norm360(lon);
  const signIndex = Math.floor(L / 30) % 12;
  const degreeInSign = L % 30;
  return { signIndex, degreeInSign, signName: SIGNS_RU[signIndex] };
}

function getNakshatra(longitude) {
  const L = norm360(longitude);
  const idx = Math.floor(L / NAKSHATRA_DEG) % 27;
  const pada = Math.floor((L % NAKSHATRA_DEG) / PADA_DEG) + 1;
  const n = NAKSHATRAS_27[idx];
  return { ...n, index: idx, pada, nakshatra: n.name };
}

/**
 * @param {Object} opts
 * @param {number} opts.year
 * @param {number} opts.month
 * @param {number} opts.day
 * @param {number} [opts.hour=12]
 * @param {number} [opts.minute=0]
 * @param {number} opts.latitude
 * @param {number} opts.longitude
 * @param {boolean} [opts.timeUnknown=false]
 * @returns {{ snapshot_text: string, snapshot_json: object, error?: string }}
 */
export function getAstroSnapshot(opts) {
  const {
    year,
    month,
    day,
    hour = 12,
    minute = 0,
    latitude,
    longitude,
    timeUnknown = false,
  } = opts;

  if (latitude == null || longitude == null || !year || !month || !day) {
    return { snapshot_text: "", snapshot_json: null, error: "Не заданы дата или координаты места рождения" };
  }

  const hourDec = hour + minute / 60;

  try {
    swisseph.swe_set_sid_mode(swisseph.SE_SIDM_LAHIRI, 0, 0);
    const jd = swisseph.swe_julday(year, month, day, hourDec, swisseph.SE_GREG_CAL);
    const flag = swisseph.SEFLG_MOSEPH | swisseph.SEFLG_SPEED | swisseph.SEFLG_SIDEREAL;

    const positions = [];
    const retrograde = [];

    for (const p of PLANETS) {
      const body = swisseph.swe_calc_ut(jd, p.id, flag);
      if (body.error) continue;
      const lon = norm360(body.longitude);
      const { signIndex, degreeInSign, signName } = lonToSignDegree(body.longitude);
      const speed = body.longitudeSpeed != null ? body.longitudeSpeed : 0;
      const isRetro = speed < 0;
      if (isRetro) retrograde.push(p.name);
      const nakshatra = getNakshatra(lon);
      positions.push({
        name: p.name,
        sign: signName,
        signIndex,
        degree: Math.round(degreeInSign * 10) / 10,
        longitude: Math.round(lon * 100) / 100,
        retrograde: isRetro,
        nakshatra: nakshatra.nakshatra,
        nakshatra_deity: nakshatra.deity,
        nakshatra_goal: nakshatra.goal,
        pada: nakshatra.pada,
      });
    }

    for (const p of EXTRA_POINTS) {
      const body = swisseph.swe_calc_ut(jd, p.id, flag);
      if (body.error) continue;
      const lon = norm360(body.longitude);
      const { signName, degreeInSign } = lonToSignDegree(lon);
      const nakshatra = getNakshatra(lon);
      positions.push({
        name: p.name,
        sign: signName,
        signIndex: Math.floor(lon / 30) % 12,
        degree: Math.round(degreeInSign * 10) / 10,
        longitude: Math.round(lon * 100) / 100,
        retrograde: false,
        nakshatra: nakshatra.nakshatra,
        nakshatra_deity: nakshatra.deity,
        nakshatra_goal: nakshatra.goal,
        pada: nakshatra.pada,
      });
    }

    const housesResult = swisseph.swe_houses_ex(jd, swisseph.SEFLG_SIDEREAL, latitude, longitude, "W");
    if (housesResult.error) {
      return { snapshot_text: "", snapshot_json: null, error: "Ошибка расчёта домов: " + housesResult.error };
    }
    const cusps = housesResult.house || [];
    const ascmc = housesResult;
    const asc = ascmc.ascendant != null ? norm360(ascmc.ascendant) : (cusps[0] != null ? norm360(cusps[0]) : 0);
    const vertex = ascmc.vertex != null ? norm360(ascmc.vertex) : null;

    const ascSignIndex = Math.floor(asc / 30) % 12;

    function getHouseWholeSign(longitude) {
      const L = norm360(longitude);
      const signIdx = Math.floor(L / 30) % 12;
      let h = (signIdx - ascSignIndex + 12) % 12;
      return h + 1;
    }

    const positionsWithHouses = positions.map((pos) => ({
      ...pos,
      house: getHouseWholeSign(pos.longitude),
    }));

    const sunLon = positions.find((p) => p.name === "Солнце")?.longitude ?? 0;
    const moonLon = positions.find((p) => p.name === "Луна")?.longitude ?? 0;
    const isDayChart = getHouseWholeSign(sunLon) <= 7;
    const parsFortuna = norm360(isDayChart ? asc + moonLon - sunLon : asc + sunLon - moonLon);
    const { signName: pfSign, degreeInSign: pfDeg } = lonToSignDegree(parsFortuna);
    const pfNakshatra = getNakshatra(parsFortuna);

    const vertexEntry = vertex != null ? {
      name: "Вертекс",
      sign: lonToSignDegree(vertex).signName,
      degree: Math.round((vertex % 30) * 10) / 10,
      longitude: Math.round(vertex * 100) / 100,
      house: getHouseWholeSign(vertex),
      nakshatra: getNakshatra(vertex).nakshatra,
      pada: getNakshatra(vertex).pada,
    } : null;

    const parsFortunaEntry = {
      name: "Парс Фортуны",
      sign: pfSign,
      degree: Math.round(pfDeg * 10) / 10,
      longitude: Math.round(parsFortuna * 100) / 100,
      house: getHouseWholeSign(parsFortuna),
      nakshatra: pfNakshatra.nakshatra,
      nakshatra_goal: pfNakshatra.goal,
      pada: pfNakshatra.pada,
    };

    const sevenPlanets = positionsWithHouses.filter((p) =>
      ["Солнце", "Луна", "Меркурий", "Венера", "Марс", "Юпитер", "Сатурн"].includes(p.name)
    );
    const sortedByLon = [...sevenPlanets].sort((a, b) => b.longitude - a.longitude);
    const charaKarakas = sortedByLon.map((p, i) => ({
      planet: p.name,
      karaka: CHARA_KARAKA_NAMES[i] || `Карака ${i + 1}`,
    }));
    const atmakaraka = sortedByLon[0] ? sortedByLon[0].name : null;

    const lagnaLordName = SIGN_LORD_NAMES[ascSignIndex];
    const lagnaLordPlanet = positions.find((p) => p.name === lagnaLordName);
    const lordSignIndex = lagnaLordPlanet != null ? lagnaLordPlanet.signIndex : 0;
    const arudhaLagnaSignIndex = (ascSignIndex + lordSignIndex) % 12;
    const arudhaLagna = SIGNS_RU[arudhaLagnaSignIndex];

    const aspectsList = [];
    const allBodies = positionsWithHouses.concat(vertexEntry ? [vertexEntry] : [], [parsFortunaEntry]);
    for (let i = 0; i < allBodies.length; i++) {
      for (let j = i + 1; j < allBodies.length; j++) {
        const a = allBodies[i].longitude;
        const b = allBodies[j].longitude;
        let diff = Math.abs(a - b);
        if (diff > 180) diff = 360 - diff;
        for (const asp of ASPECTS) {
          const orb = Math.abs(diff - asp.angle);
          if (orb <= asp.orb) {
            aspectsList.push({
              p1: allBodies[i].name,
              p2: allBodies[j].name,
              aspect: asp.name,
              angle: asp.angle,
              orb: Math.round(orb * 10) / 10,
            });
          }
        }
      }
    }

    const cuspLines = [];
    for (let i = 0; i < 12; i++) {
      const signIdx = (ascSignIndex + i) % 12;
      cuspLines.push(`${i + 1}-й дом (Whole Sign): ${SIGNS_RU[signIdx]} 0°`);
    }

    const timeNote = timeUnknown ? " (время рождения неизвестно, использован полдень; интерпретировать с осторожностью)" : "";

    const lines = [
      "Натальная карта: СИДЕРИЧЕСКИЙ зодиак (Lahiri), дома WHOLE SIGN (целознаковые)" + timeNote + ".",
      "",
      "Позиции планет и точек:",
      ...positionsWithHouses.map(
        (p) => `  ${p.name}: ${p.sign} ${p.degree}°, ${p.house}-й дом | Накшатра ${p.nakshatra} (пада ${p.pada}), божество: ${p.nakshatra_deity}, цель: ${p.nakshatra_goal}${p.retrograde ? " (R)" : ""}`
      ),
      vertexEntry ? `  ${vertexEntry.name}: ${vertexEntry.sign} ${vertexEntry.degree}°, ${vertexEntry.house}-й дом | ${vertexEntry.nakshatra}, пада ${vertexEntry.pada}` : "",
      `  ${parsFortunaEntry.name}: ${parsFortunaEntry.sign} ${parsFortunaEntry.degree}°, ${parsFortunaEntry.house}-й дом | ${parsFortunaEntry.nakshatra}, цель: ${parsFortunaEntry.nakshatra_goal}, пада ${parsFortunaEntry.pada}`,
      "",
      "Дома (Whole Sign):",
      ...cuspLines,
      "",
      "Чара-караки (показатели души и кармы):",
      ...charaKarakas.map((k) => `  ${k.karaka}: ${k.planet}`),
      `  Атмакарака (показатель Души): ${atmakaraka || "—"}`,
      "",
      "Арудха-лагна (отражённый имидж 1-го дома):",
      `  Арудха-лагна: ${arudhaLagna}`,
      "",
      "Аспекты (включая квинтиль 72°, биквинтиль 144°, минорные):",
      ...(aspectsList.length ? aspectsList.map((a) => `  ${a.p1} — ${a.aspect} — ${a.p2} (орб ${a.orb}°)`) : ["  Нет в орбе"]),
      "",
      retrograde.length ? `Ретроградные планеты: ${retrograde.join(", ")}.` : "Ретроградных планет нет.",
    ].filter(Boolean);

    const snapshot_text = lines.join("\n");
    const snapshot_json = {
      system: "sidereal_lahiri",
      house_system: "whole_sign",
      time_unknown: timeUnknown,
      positions: positionsWithHouses,
      vertex: vertexEntry,
      pars_fortuna: parsFortunaEntry,
      cusps: cuspLines,
      chara_karakas: charaKarakas,
      atmakaraka: atmakaraka,
      arudha_lagna: arudhaLagna,
      aspects: aspectsList,
      retrograde,
    };

    return { snapshot_text, snapshot_json, error: null };
  } catch (err) {
    return { snapshot_text: "", snapshot_json: null, error: String(err.message || err) };
  }
}
