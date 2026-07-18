import test from "node:test";
import assert from "node:assert/strict";

import { fetchFredSeries, fetchMacroData } from "../src/FRED_data/fred-client.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("FRED 미발표 값은 제외하고 숫자 관측값만 반환한다", async () => {
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return jsonResponse({ observations: [
      { date: "2026-07-15", value: "." },
      { date: "2026-07-14", value: "3.75" },
    ] });
  };

  const result = await fetchFredSeries({
    apiKey: "test-key",
    seriesId: "DFEDTARU",
    fetchImpl,
  });

  assert.deepEqual(result, [{ date: "2026-07-14", value: 3.75 }]);
  assert.equal(requestedUrl.searchParams.get("series_id"), "DFEDTARU");
  assert.equal(requestedUrl.searchParams.get("sort_order"), "desc");
});

test("모든 거시경제 지표를 병렬 조회해 이름별 객체로 만든다", async () => {
  const requestedSeries = [];
  const fetchImpl = async (url) => {
    requestedSeries.push(url.searchParams.get("series_id"));
    return jsonResponse({ observations: [{ date: "2026-07-01", value: "1" }] });
  };

  const result = await fetchMacroData("test-key", fetchImpl);
  assert.equal(requestedSeries.length, 6);
  assert.equal(result.series.fedUpper.observations[0].value, 1);
  assert.equal(result.series.corePce.units, "pc1");
});

test("API 키가 없으면 네트워크 요청 전에 중단한다", async () => {
  await assert.rejects(fetchMacroData(""), /FRED_API_KEY/);
});
