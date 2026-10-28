const { tools, runTool } = require("./tools");

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const MAX_TURNS = 6;

const SYSTEM =
  "너는 제주 여행 추천 도우미다. 사용자의 말에서 지역(동쪽·서쪽·서귀포·제주시)과 실내/야외 선호를 파악한다. " +
  "추천 전에 반드시 find_spots로 후보를 찾고, get_weather로 그 지역 날씨를 확인한다. " +
  "비·강풍 예보면 실내, 맑으면 야외 위주로 고르되 이유를 날씨 수치와 함께 짧게 설명한다. " +
  "추천하는 장소는 find_spots 결과에 있는 것만 쓴다. 목록 밖 장소는 없으니 지어내지 않는다. " +
  "지역을 알 수 없으면 되물어도 된다. 운영시간·요금은 모르므로 방문 전 확인하라고 안내한다. 한국어로 간결하게 답한다.";

// tools.js 의 도구 정의(name · description · input_schema)를 Gemini 형식으로 변환
const functionDeclarations = tools.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
}));

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다." });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 없습니다." });
  }
  const message = String((req.body && req.body.message) || "").trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: "message가 필요합니다." });

  const contents = [{ role: "user", parts: [{ text: message }] }];
  const trace = []; // 화면에 보여줄 도구 호출 기록

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents,
            tools: [{ functionDeclarations }],
          }),
        }
      );
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: data.error?.message || "Gemini API 오류", trace });

      const content = data.candidates?.[0]?.content;
      if (!content) {
        return res.status(502).json({ error: "Gemini 응답이 비어 있습니다. (" + (data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "원인 불명") + ")", trace });
      }
      const parts = content.parts || [];
      contents.push({ role: "model", parts });

      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const answer = parts.map((p) => p.text || "").join("").trim();
        return res.status(200).json({ answer, trace });
      }

      // 모델이 요청한 도구들을 실행해 결과를 돌려준다
      const responses = [];
      for (const { functionCall: fc } of calls) {
        const out = await runTool(fc.name, fc.args || {});
        trace.push({ tool: fc.name, input: fc.args || {}, output: out });
        responses.push({ functionResponse: { name: fc.name, response: { result: out } } });
      }
      contents.push({ role: "user", parts: responses });
    }
    return res.status(200).json({ answer: "도구 호출이 너무 길어져 중단했습니다. 질문을 더 구체적으로 해주세요.", trace });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e), trace });
  }
};
