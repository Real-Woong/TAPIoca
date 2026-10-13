import test from "node:test";
import assert from "node:assert/strict";

import { fetchBaseRate } from "../src/portfolio/base-fx.js";

function fakeFetch(body, { ok = true, status = 200 } = {}, calls = []) {
  return async (url) => {
    calls.push(url);
    return { ok, status, json: async () => body };
  };
}

const row = (time, value) => ({ TIME: time, DATA_VALUE: value });

test("가장 최근 영업일의 매매기준율을 고른다", async () => {
  const calls = [];
  const result = await fetchBaseRate({
    apiKey: "KEY",
    now: new Date("2026-10-13T05:00:00Z"),
    fetchImpl: fakeFetch({ StatisticSearch: { row: [
      row("20261012", "1338"), row("20261008", "1339.2"), row("20261013", "1335.8"),
    ] } }, {}, calls),
  });

  assert.deepEqual(result, { rate: 1335.8, date: "2026-10-13" });
  assert.match(calls[0], /\/KEY\/json\/kr\/1\/10\/731Y001\/D\/20261003\/20261013\/0000001$/);
});

test("한국시간 기준으로 날짜 범위를 만든다", async () => {
  const calls = [];
  await fetchBaseRate({
    apiKey: "KEY",
    now: new Date("2026-10-12T20:30:00Z"), // 한국시간 10/13 05:30
    fetchImpl: fakeFetch({ StatisticSearch: { row: [row("20261012", "1338")] } }, {}, calls),
  });

  assert.match(calls[0], /\/20261003\/20261013\/0000001$/);
});

test("오류 응답과 빈 값은 숫자로 위장하지 않고 던진다", async () => {
  const now = new Date("2026-10-13T05:00:00Z");
  await assert.rejects(
    fetchBaseRate({ now, fetchImpl: fakeFetch({}, { ok: false, status: 500 }) }),
    /HTTP 500/,
  );
  await assert.rejects(
    fetchBaseRate({ now, fetchImpl: fakeFetch({ RESULT: { MESSAGE: "인증키가 유효하지 않습니다.\n자세히" } }) }),
    /인증키가 유효하지 않습니다/,
  );
  await assert.rejects(
    fetchBaseRate({ now, fetchImpl: fakeFetch({ StatisticSearch: { row: [row("20261013", "")] } }) }),
    /읽을 수 없습니다/,
  );
});
