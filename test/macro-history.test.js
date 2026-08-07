import test from "node:test";
import assert from "node:assert/strict";

import { chunkVintageWindows } from "../src/backtest/macro-cache.js";
import {
  compareSahmSources,
  computeSahm,
  macroDataAsOf,
  macroScoreTimeline,
  observationsAsOf,
  summarizeMacroTimeline,
  toYearOverYear,
} from "../src/backtest/macro-history.js";
import { parseStooqBars, parseTwelveDataBars, parseYahooBars } from "../src/market/trend-signal.js";

/**
 * 거시 층을 과거 시점으로 되살리는 규칙을 고정합니다.
 *
 * 여기서 잡으려는 실수는 look-ahead입니다. FRED가 기본으로 주는 값은 개정된
 * 값이라, 그대로 백테스트에 넣으면 그때는 아무도 몰랐던 확정치로 매매한 것이
 * 됩니다. **그 실수는 성과를 좋게 만들기 때문에 결과만 봐서는 안 드러납니다.**
 * 그래서 테스트로 잡습니다.
 */

// 실업률 2008-09월치: 처음 6.1로 발표됐다가 나중에 6.2로 개정됐다는 가정입니다.
const UNEMPLOYMENT = [
  { date: "2008-09-01", value: 6.1, realtimeStart: "2008-10-03", realtimeEnd: "2009-02-05" },
  { date: "2008-09-01", value: 6.2, realtimeStart: "2009-02-06", realtimeEnd: "9999-12-31" },
  { date: "2008-08-01", value: 6.1, realtimeStart: "2008-09-05", realtimeEnd: "9999-12-31" },
];

test("발표 전의 값은 그날의 판단에 들어가지 않는다", () => {
  // 9월치는 10월 3일에 발표됐으므로 9월 15일에는 8월치가 최신입니다.
  const asOfMidSeptember = observationsAsOf(UNEMPLOYMENT, "2008-09-15");
  assert.equal(asOfMidSeptember.length, 1);
  assert.equal(asOfMidSeptember[0].date, "2008-08-01");
});

test("개정 전에는 최초 발표값을, 개정 후에는 개정값을 쓴다", () => {
  const beforeRevision = observationsAsOf(UNEMPLOYMENT, "2008-11-01");
  assert.equal(beforeRevision[0].date, "2008-09-01");
  assert.equal(beforeRevision[0].value, 6.1, "개정 전에는 최초 발표값 6.1이다");

  const afterRevision = observationsAsOf(UNEMPLOYMENT, "2009-03-01");
  assert.equal(afterRevision[0].date, "2008-09-01");
  assert.equal(afterRevision[0].value, 6.2, "개정 후에는 6.2다");
});

test("관측은 날짜 내림차순이고 같은 날짜는 하나만 남는다", () => {
  // evaluateMacroRegime이 observations[0]을 최신값으로 읽고 인덱스로 과거를
  // 세므로(3개월 전 = [3]), 이 두 성질이 깨지면 조용히 틀린 값을 계산합니다.
  const asOf = observationsAsOf(UNEMPLOYMENT, "2009-03-01");
  assert.deepEqual(asOf.map((item) => item.date), ["2008-09-01", "2008-08-01"]);
});

test("realtimeStart가 없는 관측은 되살리기에 쓰지 않는다", () => {
  // vintage 없이 받은 데이터입니다. 언제 알려졌는지 모르므로 쓰면 look-ahead입니다.
  const withoutVintage = [{ date: "2008-09-01", value: 6.1 }];
  assert.deepEqual(observationsAsOf(withoutVintage, "2020-01-01"), []);
});

test("지표 이력이 모자라면 점수를 0이 아니라 null로 남긴다", () => {
  // 0은 "중립"이라는 판단이고 null은 "모른다"입니다. 같은 값으로 적으면
  // 워밍업 구간을 나중에 구분할 수 없습니다.
  const vintages = { series: { unemployment: { observations: UNEMPLOYMENT } } };
  const scores = macroScoreTimeline(vintages, ["2008-09-15"]);
  assert.deepEqual(scores, [null]);
});

test("as-of 시점의 series 모양이 evaluateMacroRegime이 기대하는 것과 같다", () => {
  const vintages = {
    series: { unemployment: { id: "UNRATE", observations: UNEMPLOYMENT } },
  };
  const asOf = macroDataAsOf(vintages, "2008-11-01");
  assert.equal(asOf.series.unemployment.id, "UNRATE", "설정 필드는 그대로 남는다");
  assert.equal(asOf.series.unemployment.observations[0].value, 6.1);
});

test("되살린 점수가 상수인지 움직이는지 요약이 갈라 준다", () => {
  assert.equal(summarizeMacroTimeline([null, null]).count, 0);

  const flat = summarizeMacroTimeline([-0.5, -0.5, -0.5]);
  assert.equal(flat.stdev, 0, "안 움직이면 표준편차가 0이다 — 신호가 아니라 상수다");
  assert.equal(flat.changeDays, 0);

  const moving = summarizeMacroTimeline([-0.5, -3.5, -0.5, null]);
  assert.equal(moving.count, 3);
  assert.equal(moving.unknown, 1);
  assert.equal(moving.min, -3.5);
  assert.equal(moving.changeDays, 2);
});

/**
 * ── FRED의 제약 둘 ────────────────────────────────────────────────────────
 *
 * 2026-08-07에 실측으로 드러난 것입니다.
 *  1. 한 요청에 vintage 날짜는 2000개까지 (T10Y2Y 3094, DFEDTARL 5067)
 *  2. units가 lin이 아니면 realtime 범위를 하루로 고정해야 함 (PCEPILFE의 pc1)
 */

test("vintage 날짜가 2000개를 넘으면 나눠 요청한다", () => {
  const dates = Array.from({ length: 5067 }, (_, index) => `2000-01-${index}`);
  const windows = chunkVintageWindows(dates);

  assert.equal(windows.length, 3, "5067개는 1900씩 세 창으로 갈린다");
  assert.equal(windows[0].start, dates[0]);
  // 마지막 창의 끝은 열어둬야 이후에 나올 개정본까지 들어옵니다.
  assert.equal(windows.at(-1).end, "9999-12-31");
});

test("vintage가 적으면 한 번에 받는다", () => {
  assert.equal(chunkVintageWindows(["2008-10-03", "2009-02-06"]).length, 1);
  assert.equal(chunkVintageWindows([]).length, 1, "목록이 비어도 요청은 한 번 나간다");
});

test("전년 대비 변환은 as-of 필터 뒤에 하므로 개정된 미래 값이 안 섞인다", () => {
  // 원지수를 내림차순으로 13개 만듭니다. 12칸 뒤가 1년 전입니다.
  const index = Array.from({ length: 13 }, (_, offset) => ({
    date: `2026-${String(12 - offset).padStart(2, "0")}-01`,
    value: 100 + (12 - offset),
    realtimeStart: "2020-01-01",
  }));

  const yoy = toYearOverYear(index);
  assert.equal(yoy.length, 1, "1년치가 있어야 한 점이 나온다");
  // 112 / 100 − 1 = 12%
  assert.ok(Math.abs(yoy[0].value - 12) < 1e-9, `12%여야 한다: ${yoy[0].value}`);
  assert.equal(yoy[0].date, index[0].date, "관측일은 그대로다");
});

test("transform이 붙은 시리즈만 변환하고 나머지는 원값을 유지한다", () => {
  const vintages = {
    series: {
      corePce: {
        transform: "pc1",
        observations: Array.from({ length: 13 }, (_, offset) => ({
          date: `2026-${String(12 - offset).padStart(2, "0")}-01`,
          value: 100 + (12 - offset),
          realtimeStart: "2020-01-01",
        })),
      },
      unemployment: { transform: null, observations: UNEMPLOYMENT },
    },
  };

  const asOf = macroDataAsOf(vintages, "2026-12-31");
  assert.ok(Math.abs(asOf.series.corePce.observations[0].value - 12) < 1e-9);
  assert.equal(asOf.series.unemployment.observations[0].value, 6.2, "변환 없는 층은 그대로다");
});

/**
 * ── 2008년을 되살리기 위해 메운 두 구멍 ────────────────────────────────────
 *
 * 여섯 지표 중 하나라도 비면 그날은 판정 불가입니다. 둘이 짧았습니다.
 *  · SAHMREALTIME은 규칙이 발표된 2019년부터만 있습니다(vintage 82개)
 *  · DFEDTARL/U는 연준이 목표 "범위"를 쓰기 시작한 2008-12부터만 있습니다
 * 그래서 되살릴 수 있는 구간이 2019년 이후로 잘렸고 금융위기가 통째로 빠졌습니다.
 */

/** 실업률을 내림차순 월간 관측으로 만듭니다. values[0]이 최신입니다. */
function unemploymentSeries(values, realtimeStart = "2000-01-01") {
  return values.map((value, offset) => ({
    date: `2008-${String(12 - offset).padStart(2, "0")}-01`,
    value,
    realtimeStart,
  }));
}

test("Sahm을 실업률에서 직접 계산한다 — 3개월 평균 − 직전 12개월 최저", () => {
  // 최근 3개월이 6.0으로 올라오고 그 전 12개월은 4.5에 붙박이인 경우입니다.
  const series = unemploymentSeries([6, 6, 6, ...Array(12).fill(4.5)]);
  const sahm = computeSahm(series);

  // MA3(0) = 6.0, 직전 12개월 MA3의 최저 = 4.5 → 1.5
  assert.equal(sahm[0].value, 1.5);
  assert.equal(sahm[0].date, series[0].date, "관측일은 실업률의 것을 따른다");
});

test("실업률이 평평하면 Sahm은 0이다", () => {
  assert.equal(computeSahm(unemploymentSeries(Array(15).fill(5)))[0].value, 0);
});

test("15개월치가 없으면 Sahm을 계산하지 않는다", () => {
  // 3개월 평균 13개가 필요하므로 최소 15개 관측이 있어야 한 점이 나옵니다.
  assert.deepEqual(computeSahm(unemploymentSeries(Array(14).fill(5))), []);
  assert.equal(computeSahm(unemploymentSeries(Array(15).fill(5))).length, 1);
});

test("Sahm은 SAHMREALTIME이 있어도 항상 계산값을 쓴다", () => {
  // 2019년을 경계로 출처가 바뀌면 그 지점에서 값의 성격이 달라져 국면 비교가
  // 오염됩니다. 그래서 겹치는 구간에서도 계산값으로 통일합니다.
  const vintages = {
    series: {
      unemployment: { observations: unemploymentSeries([6, 6, 6, ...Array(12).fill(4.5)]) },
      sahm: { observations: [{ date: "2008-12-01", value: 99, realtimeStart: "2000-01-01" }] },
    },
  };

  const asOf = macroDataAsOf(vintages, "2026-01-01");
  assert.equal(asOf.series.sahm.observations[0].value, 1.5, "FRED 값 99가 아니라 계산값이다");
  assert.equal(asOf.series.sahm.id, "SAHM_COMPUTED");
});

test("2008-12 이전 기준금리는 단일 목표(DFEDTAR)로 이어 붙인다", () => {
  const vintages = {
    series: {
      fedUpper: {
        observations: [{ date: "2008-12-16", value: 0.25, realtimeStart: "2008-12-16" }],
      },
      fedLower: {
        observations: [{ date: "2008-12-16", value: 0, realtimeStart: "2008-12-16" }],
      },
      fedLegacy: {
        observations: [
          { date: "2008-10-08", value: 1.5, realtimeStart: "2008-10-08" },
          { date: "2007-09-18", value: 4.75, realtimeStart: "2007-09-18" },
        ],
      },
    },
  };

  const asOf = macroDataAsOf(vintages, "2009-01-01");
  const dates = asOf.series.fedUpper.observations.map((item) => item.date);
  // 내림차순으로 이어져야 valueOnOrBefore가 90일 전 값을 제대로 찾습니다.
  assert.deepEqual(dates, ["2008-12-16", "2008-10-08", "2007-09-18"]);
  // 2007년 9월의 4.75%가 살아 있어야 2008년 인하 사이클이 점수에 잡힙니다.
  assert.equal(asOf.series.fedUpper.observations.at(-1).value, 4.75);
});

test("2008-12 이전만 조회하면 단일 목표만 남는다", () => {
  const vintages = {
    series: {
      fedUpper: {
        observations: [{ date: "2008-12-16", value: 0.25, realtimeStart: "2008-12-16" }],
      },
      fedLegacy: {
        observations: [{ date: "2007-09-18", value: 4.75, realtimeStart: "2007-09-18" }],
      },
    },
  };

  const asOf = macroDataAsOf(vintages, "2008-06-01");
  assert.deepEqual(
    asOf.series.fedUpper.observations.map((item) => item.value),
    [4.75],
    "아직 발표되지 않은 범위 목표는 안 들어온다",
  );
});

test("Sahm 계산과 FRED 값을 겹치는 구간에서 대조할 수 있다", () => {
  const vintages = {
    series: {
      unemployment: { observations: unemploymentSeries([6, 6, 6, ...Array(12).fill(4.5)]) },
      sahm: { observations: [{ date: "2008-12-01", value: 1.5, realtimeStart: "2000-01-01" }] },
    },
  };

  const check = compareSahmSources(vintages, ["2026-01-01"]);
  assert.equal(check.count, 1);
  assert.equal(check.maxAbsDiff, 0, "계산이 맞으면 차이가 0이다");
  assert.equal(check.exactMatches, 1);
});

/**
 * ── 일봉의 실제 날짜 ──────────────────────────────────────────────────────
 *
 * 거시 되살리기는 "이 종가가 며칠인가"를 알아야 성립합니다. 예전에는 파서가
 * 종가만 남기고 날짜를 버려서, 백테스터가 2020-01-02부터 평일을 세는 가짜
 * 달력을 썼습니다. 5000일 표본이면 2039년까지 갑니다.
 */

test("Twelve Data 응답에서 날짜를 오래된 순으로 함께 뽑는다", () => {
  const body = JSON.stringify({
    values: [
      { datetime: "2026-08-07", close: "310.5" },
      { datetime: "2026-08-06", close: "308.0" },
    ],
  });
  assert.deepEqual(parseTwelveDataBars(body), [
    { date: "2026-08-06", close: 308 },
    { date: "2026-08-07", close: 310.5 },
  ]);
});

test("Yahoo 응답의 epoch 초를 날짜로 바꾼다", () => {
  const body = JSON.stringify({
    chart: {
      result: [{
        timestamp: [1_754_524_800],
        indicators: { quote: [{ close: [310.5] }] },
      }],
    },
  });
  assert.deepEqual(parseYahooBars(body), [{ date: "2025-08-07", close: 310.5 }]);
});

test("Stooq CSV에서 Date 열을 찾아 쓴다", () => {
  const csv = "Date,Open,High,Low,Close,Volume\n2026-08-06,1,2,3,308.0,10\n";
  assert.deepEqual(parseStooqBars(csv), [{ date: "2026-08-06", close: 308 }]);
});

test("종가만 뽑는 기존 함수는 동작이 그대로다", () => {
  const csv = "Date,Open,High,Low,Close,Volume\n2026-08-06,1,2,3,308.0,10\n";
  assert.deepEqual(parseStooqBars(csv).map((bar) => bar.close), [308]);
});
