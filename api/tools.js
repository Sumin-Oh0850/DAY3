const { spots } = require("../jeju_spots.json");

const MAX_RESULTS = 8;
const AREAS = ["동쪽", "서쪽", "서귀포", "제주시"];

// Claude 도구 설명
const findSpotsTool = {
  name: "find_spots",
  description:
    "제주 관광지 목록(jeju_spots.json)에서 지역과 실내 여부로 장소를 찾아 최대 8곳을 돌려준다. " +
    "반환되는 장소는 이 목록에 있는 것뿐이며, 목록 밖 장소는 없다. " +
    "결과에 없는 장소를 지어내거나 추천하지 말고, 해당하는 곳이 없으면 없다고 답한다. " +
    "운영시간·요금·휴무 정보는 담겨 있지 않다.",
  input_schema: {
    type: "object",
    properties: {
      area: {
        type: "string",
        enum: AREAS,
        description: "찾을 지역: 동쪽, 서쪽, 서귀포, 제주시 중 하나",
      },
      indoor: {
        type: "boolean",
        description: "true면 실내만, false면 야외만. 생략하면 구분하지 않는다.",
      },
    },
    required: ["area"],
  },
};

// 도구 실행: spots에서 골라 이름 · 지역 · 실내 여부 · 설명(type)만 반환(좌표 제외)
function find_spots({ area, indoor } = {}) {
  if (!AREAS.includes(area)) {
    return { error: `area는 ${AREAS.join(" · ")} 중 하나여야 합니다.` };
  }
  // "동쪽" → "동쪽(성산)", "동쪽(구좌)" 포함. "서귀포", "제주시"는 그대로 일치
  const matched = spots.filter(
    (s) =>
      (s.area === area || s.area.startsWith(area + "(")) &&
      (indoor === undefined || indoor === null || s.indoor === indoor)
  );
  return {
    total: matched.length,
    spots: matched.slice(0, MAX_RESULTS).map((s) => ({
      name: s.name,
      areas: s.area,
      indoor: s.indoor,
      description: s.type,
    })),
  };
}

// ---- get_weather (Open-Meteo, API 키 불필요) ----
const AREA_COORDS = {
  동쪽: [33.46, 126.85],
  서쪽: [33.38, 126.3],
  서귀포: [33.2541, 126.5601],
  제주시: [33.4996, 126.5312],
};

const WMO = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림",
  45: "안개", 48: "안개", 51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비", 71: "약한 눈", 73: "눈", 75: "강한 눈",
  80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 95: "뇌우", 96: "뇌우(우박)", 99: "뇌우(우박)",
};

const getWeatherTool = {
  name: "get_weather",
  description:
    "제주 지역(동쪽, 서쪽, 서귀포, 제주시)의 현재 날씨와 오늘~모레 3일 예보를 Open-Meteo에서 가져온다. " +
    "비·바람 때문에 실내/야외 추천이 달라질 때 장소를 고르기 전에 호출한다.",
  input_schema: {
    type: "object",
    properties: {
      area: { type: "string", enum: AREAS, description: "날씨를 볼 지역: 동쪽, 서쪽, 서귀포, 제주시 중 하나" },
    },
    required: ["area"],
  },
};

async function get_weather({ area } = {}) {
  const c = AREA_COORDS[area];
  if (!c) return { error: `area는 ${AREAS.join(" · ")} 중 하나여야 합니다.` };
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" + c[0] + "&longitude=" + c[1] +
    "&current=temperature_2m,precipitation,weather_code,wind_speed_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=Asia%2FSeoul&forecast_days=3";
  const res = await fetch(url);
  if (!res.ok) return { error: `날씨 API 오류 (${res.status})` };
  const j = await res.json();
  return {
    area,
    now: {
      weather: WMO[j.current.weather_code] || `코드 ${j.current.weather_code}`,
      temp_c: j.current.temperature_2m,
      rain_mm: j.current.precipitation,
      wind_kmh: j.current.wind_speed_10m,
    },
    forecast: j.daily.time.map((d, i) => ({
      date: d,
      weather: WMO[j.daily.weather_code[i]] || `코드 ${j.daily.weather_code[i]}`,
      max_c: j.daily.temperature_2m_max[i],
      min_c: j.daily.temperature_2m_min[i],
      rain_chance_pct: j.daily.precipitation_probability_max[i],
    })),
  };
}

// 에이전트용: 도구 정의 목록과 실행기
const tools = [findSpotsTool, getWeatherTool];
const handlers = { find_spots, get_weather };
async function runTool(name, input) {
  const fn = handlers[name];
  if (!fn) return { error: `알 수 없는 도구: ${name}` };
  try {
    return await fn(input);
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

module.exports = { findSpotsTool, find_spots, getWeatherTool, get_weather, tools, runTool };
