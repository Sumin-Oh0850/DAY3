const { tools, runTool } = require("./tools");

const MODEL = "claude-sonnet-5-5";
const MAX_TURNS = 6;

const SYSTEM =
  "너는 제주 여행 추천 도우미다. 사용자의 말에서 지역(동쪽·서쪽·서귀포·제주시)과 실내/야외 선호를 파악한다. " +
  "추천 전에 반드시 find_spots로 후보를 찾고, get_weather로 그 지역 날씨를 확인한다. " +
  "비·강풍 예보면 실내, 맑으면 야외 위주로 고르되 이유를 날씨 수치와 함께 짧게 설명한다. " +
  "추천하는 장소는 find_spots 결과에 있는 것만 쓴다. 목록 밖 장소는 없으니 지어내지 않는다. " +
  "지역을 알 수 없으면 되물어도 된다. 운영시간·요금은 모르므로 방문 전 확인하라고 안내한다. 한국어로 간결하게 답한다.";

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다." });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY 환경변수가 없습니다." });
  }
  const message = String((req.body && req.body.message) || "").trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: "message가 필요합니다." });

  const messages = [{ role: "user", content: message }];
  const trace = []; // 화면에 보여줄 도구 호출 기록

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: data.error?.message || "Claude API 오류", trace });

      messages.push({ role: "assistant", content: data.content });
      if (data.stop_reason !== "tool_use") {
        const answer = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        return res.status(200).json({ answer, trace });
      }

      // 모델이 요청한 도구들을 실행해 결과를 돌려준다
      const results = [];
      for (const b of data.content.filter((b) => b.type === "tool_use")) {
        const out = await runTool(b.name, b.input);
        trace.push({ tool: b.name, input: b.input, output: out });
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
    }
    return res.status(200).json({ answer: "도구 호출이 너무 길어져 중단했습니다. 질문을 더 구체적으로 해주세요.", trace });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e), trace });
  }
};
