const { tools, runTool } = require("./tools");

// 앞에서부터 순서대로 사용하고, 한도 초과·사용 불가면 다음 모델로 교체한다.
// Vercel 환경변수 GEMINI_MODELS(쉼표 구분)로 목록을 바꿀 수 있다.
const MODELS = (process.env.GEMINI_MODELS ||
  "gemini-3.8-flash,gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-3-flash,gemini-2.5-flash,gemini-flash-latest")
  .split(",").map((s) => s.trim()).filter(Boolean);
const unavailableUntil = {}; // 모델 → 다시 시도할 수 있는 시각(ms)
const MAX_TURNS = 6;
const CALL_TIMEOUT_MS = 15000; // 모델 한 번 호출의 제한 시간

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

// 모델 목록을 순서대로 시도한다. 한도 초과(429)는 1분, 사용 불가(404 등)는 1시간 건너뛴다.
async function callGemini(contents, skipped) {
  let lastError = "사용 가능한 모델이 없습니다.";
  for (const model of MODELS) {
    if ((unavailableUntil[model] || 0) > Date.now()) continue;
    let r, data;
    try {
      r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents,
            tools: [{ functionDeclarations }],
          }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS), // 응답이 없으면 다음 모델로
        }
      );
      data = await r.json();
    } catch (e) {
      lastError = `${model}: 응답 지연/연결 실패 (${e.name})`;
      unavailableUntil[model] = Date.now() + 60 * 1000;
      skipped.push(model);
      continue;
    }
    if (r.ok) return { data, model };

    const msg = data.error?.message || `HTTP ${r.status}`;
    lastError = `${model}: ${msg}`;
    const quota = r.status === 429 || /quota|exhausted|rate/i.test(msg);
    const gone = r.status === 404 || /no longer available|not found|not supported/i.test(msg);
    if (!quota && !gone && r.status !== 503) throw new Error(lastError); // 요청 자체 오류는 모델을 바꿔도 같다
    unavailableUntil[model] = Date.now() + (quota ? 60 * 1000 : 60 * 60 * 1000);
    skipped.push(model);
  }
  throw new Error("모든 모델을 사용할 수 없습니다. 마지막 오류 → " + lastError);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 지원합니다." });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 없습니다." });
  }
  const message = String((req.body && req.body.message) || "").trim().slice(0, 500);
  if (!message) return res.status(400).json({ error: "message가 필요합니다." });

  const contents = [{ role: "user", parts: [{ text: message }] }];
  const trace = []; // 화면에 보여줄 도구 호출 기록
  const skipped = []; // 한도 초과·사용 불가로 건너뛴 모델
  let used = null;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { data, model } = await callGemini(contents, skipped);
      used = model;

      const content = data.candidates?.[0]?.content;
      if (!content) {
        return res.status(502).json({ error: "Gemini 응답이 비어 있습니다. (" + (data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "원인 불명") + ")", trace, model: used, skipped });
      }
      const parts = content.parts || [];
      contents.push({ role: "model", parts });

      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const answer = parts.map((p) => p.text || "").join("").trim();
        return res.status(200).json({ answer, trace, model: used, skipped });
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
    return res.status(500).json({ error: String(e.message || e), trace, model: used, skipped });
  }
};
