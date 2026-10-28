const path = require("path");
const { spots } = require(path.join(__dirname, "..", "jeju_spots.json"));

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

module.exports = { findSpotsTool, find_spots };
