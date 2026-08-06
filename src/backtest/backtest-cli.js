#!/usr/bin/env node

import path from "node:path";

import { loadTradingPolicy } from "../paper/trading-policy.js";
import { runBacktest } from "./backtest-engine.js";
import { fetchAndCacheCloses, loadCachedCloses } from "./price-cache.js";
import { buildScenario, SCENARIOS } from "./scenarios.js";

/**
 * 백테스트 실행기입니다.
 *
 *   npm run backtest                      기본 비교(청산 규칙) 실행
 *   npm run backtest -- --compare macd    MACD 가중치 비교
 *   npm run backtest -- --compare vol     변동성 관리 목표 비교
 *   npm run backtest -- --compare stop    손절 문턱: 고정 비율 대 변동성 배수
 *   npm run backtest -- --blocks 5        표본을 5등분해 지표가 얼마나 흔들리는지
 *   npm run backtest -- --compare source  낙폭 우위가 어느 레이어에서 오는지
 *   npm run backtest -- --fetch           실데이터 일봉을 받아 캐시에 저장
 *   npm run backtest -- --source cache    캐시된 실데이터로 실행
 *
 * 비교 종류: exit, macd, band, cost, strategy, vol, source, stop, stopcost, trend
 *
 * `--blocks N`은 표본을 겹치지 않는 N구간으로 나눠 각 구간에서 따로 비교합니다.
 * 전체 한 번만 돌리면 차이가 우연인지 알 수 없습니다. 구간마다 부호가 뒤집히면
 * 그 차이는 노이즈입니다.
 *
 * 파라미터를 바꾸기 전에 반드시 여기서 먼저 재십시오. 20일치 PAPER 운용으로는
 * 손절선 같은 경로 의존 규칙의 효과를 구분할 수 없습니다.
 */

// 일봉 백테스트에서는 사이클 하나가 하루이므로 레짐 확정도 사이클 단위로 지정합니다.
// 운영 기본값(거래일 1일 = 26사이클)을 그대로 쓰면 26거래일 확정이 돼버립니다.
const BASE_ENV = {
  MAX_ORDER_USD: "5",
  MAX_DAILY_BUY_USD: "10",
  TRADE_COST_RATE: "0.001",
  REGIME_CONFIRM_CYCLES: "1",
};

/** 기본 표의 주식 비율(VTI:SCHD:IWM = 7:2:0)을 유지한 채 주식 총량만 바꿉니다. */
function EQUITY_MIX(equityWeight) {
  const share = { VTI: 0.7, SCHD: 0.2, IWM: 0 };
  const total = Object.values(share).reduce((sum, value) => sum + value, 0);
  const allocation = { CASH: Math.round((1 - equityWeight) * 1000) / 1000 };
  for (const [symbol, weight] of Object.entries(share)) {
    allocation[symbol] = Math.round((weight / total) * equityWeight * 1000) / 1000;
  }
  return allocation;
}

const COMPARISONS = {
  exit: {
    label: "청산 규칙 (P0에서 바꾼 기본값 검증)",
    variants: [
      { name: "현재: 손절12%·트레일링off·보유기간off", env: {} },
      {
        name: "이전: 손절3%·트레일링2.5/1.5%·15일",
        env: {
          STOP_LOSS_RATE: "0.03",
          TRAILING_ACTIVATION_RATE: "0.025",
          TRAILING_DRAWDOWN_RATE: "0.015",
          MAX_HOLDING_DAYS: "15",
        },
      },
      { name: "손절만 3%로 좁힘", env: { STOP_LOSS_RATE: "0.03" } },
      { name: "보유기간 15일만 켬", env: { MAX_HOLDING_DAYS: "15" } },
    ],
  },
  macd: {
    label: "MACD 가중치 (P1-3: 0.15는 결정에 영향이 없다)",
    variants: [
      { name: "MACD 제거 (0)", signal: { macdWeight: 0 } },
      { name: "현재 (0.15)", signal: { macdWeight: 0.15 } },
      { name: "0.5", signal: { macdWeight: 0.5 } },
      { name: "1.0", signal: { macdWeight: 1 } },
    ],
  },
  band: {
    label: "무거래 밴드 (회전율 대 추적오차)",
    variants: [
      { name: "1%", env: { REBALANCE_BAND_RATE: "0.01" } },
      { name: "현재 5%", env: { REBALANCE_BAND_RATE: "0.05" } },
      { name: "10%", env: { REBALANCE_BAND_RATE: "0.10" } },
    ],
  },
  cost: {
    label: "거래비용 민감도 (엣지가 비용을 견디는가)",
    variants: [
      { name: "비용 0", env: { TRADE_COST_RATE: "0" } },
      { name: "현재 10bp", env: { TRADE_COST_RATE: "0.001" } },
      { name: "30bp", env: { TRADE_COST_RATE: "0.003" } },
    ],
  },
  strategy: {
    label: "신호 스택 대 정적 배분 (레이어가 값을 하는가)",
    variants: [
      { name: "현재 신호 스택 (FRED+추세+MACD)", options: {} },
      { name: "정적 90/10 (주식90·현금10)", options: { staticAllocation: EQUITY_MIX(0.9) } },
      { name: "정적 70/30", options: { staticAllocation: EQUITY_MIX(0.7) } },
      { name: "정적 50/50", options: { staticAllocation: EQUITY_MIX(0.5) } },
    ],
  },
  // Kaminski & Lo(2014)는 손절 문턱을 고정 비율이 아니라 표준편차 배수(-1.5σ ~ -0.5σ)로
  // 잡습니다. 고정 비율은 변동성에 반비례해 잘못 스케일됩니다 — 12%는 연율 변동성
  // 14%에서 0.85σ지만 40%짜리 폭락장에서는 0.30σ가 되어, 가장 팔면 안 되는 순간에
  // 가장 쉽게 발동합니다. 같은 논문의 명제 1·3은 애초에 손절이 값을 못 할 수도
  // 있다고 말하므로 "손절 없음"도 후보에 넣습니다.
  stop: {
    label: "손절 문턱: 고정 비율 대 변동성 배수 (Kaminski & Lo 2014)",
    variants: [
      // 손절선 100%는 현실적으로 도달 불가라 규칙을 끈 것과 같습니다.
      { name: "손절 없음", env: { STOP_LOSS_RATE: "0.99" } },
      { name: "고정 3% (이전 기본값)", env: { STOP_LOSS_RATE: "0.03" } },
      { name: "고정 12% (현재)", env: {} },
      { name: "변동성 0.5σ", env: { STOP_LOSS_SIGMA: "0.5" } },
      { name: "변동성 0.85σ (12%와 등가)", env: { STOP_LOSS_SIGMA: "0.85" } },
      { name: "변동성 1.5σ", env: { STOP_LOSS_SIGMA: "1.5" } },
    ],
  },
  // 손절 3%는 회전율을 35~41% 늘리는 대신 CDaR를 1.0~1.6%p 낮춥니다. 그 균형이
  // 편도 10bp 가정 위에서만 성립하는지 확인합니다. 비용이 오르면 3%가 먼저 무너집니다.
  stopcost: {
    label: "손절 문턱 × 거래비용 (3%의 CDaR 우위가 비용을 견디는가)",
    variants: [
      { name: "손절없음 · 10bp", env: { STOP_LOSS_RATE: "0.99", TRADE_COST_RATE: "0.001" } },
      { name: "3% · 10bp", env: { STOP_LOSS_RATE: "0.03", TRADE_COST_RATE: "0.001" } },
      { name: "12% · 10bp", env: { TRADE_COST_RATE: "0.001" } },
      { name: "손절없음 · 30bp", env: { STOP_LOSS_RATE: "0.99", TRADE_COST_RATE: "0.003" } },
      { name: "3% · 30bp", env: { STOP_LOSS_RATE: "0.03", TRADE_COST_RATE: "0.003" } },
      { name: "12% · 30bp", env: { TRADE_COST_RATE: "0.003" } },
      { name: "손절없음 · 50bp", env: { STOP_LOSS_RATE: "0.99", TRADE_COST_RATE: "0.005" } },
      { name: "3% · 50bp", env: { STOP_LOSS_RATE: "0.03", TRADE_COST_RATE: "0.005" } },
      { name: "12% · 50bp", env: { TRADE_COST_RATE: "0.005" } },
    ],
  },
  vol: {
    label: "변동성 관리 목표 (Moreira & Muir 2017)",
    variants: [
      // volTarget 0이면 exposureMultiplier가 1로 고정돼 레이어가 꺼집니다.
      { name: "끔 (변동성 관리 없음)", signal: { volTarget: 0 } },
      { name: "0.10 (강하게 줄임)", signal: { volTarget: 0.1 } },
      { name: "현재 0.15", signal: { volTarget: 0.15 } },
      { name: "0.20 (약하게 줄임)", signal: { volTarget: 0.2 } },
    ],
  },
  // §7에서 신호 스택이 정적 배분을 낙폭에서 이긴다는 것까지는 확인했지만,
  // 그 우위가 추세에서 오는지 변동성 관리에서 오는지는 갈리지 않았습니다.
  // 두 레이어를 하나씩 끄고 정적 배분과 나란히 놓으면 출처가 드러납니다.
  source: {
    label: "낙폭 우위의 출처 (추세인가 변동성 관리인가)",
    variants: [
      { name: "현재 스택 (추세1 + 변동성0.15)", signal: {} },
      { name: "변동성 관리만 끔", signal: { volTarget: 0 } },
      { name: "추세만 끔", signal: { trendWeight: 0 } },
      { name: "둘 다 끔", signal: { trendWeight: 0, volTarget: 0 } },
      // 대조군. "둘 다 끔"이 여기까지 내려오면 우위는 두 레이어에서 온 것입니다.
      { name: "정적 70/30 (대조군)", options: { staticAllocation: EQUITY_MIX(0.7) } },
    ],
  },
  trend: {
    label: "추세 가중치 (Faber 레이어의 기여)",
    variants: [
      { name: "추세 제거 (0)", signal: { trendWeight: 0 } },
      { name: "현재 (1)", signal: { trendWeight: 1 } },
      { name: "2", signal: { trendWeight: 2 } },
    ],
  },
};

const options = parseArgs(process.argv.slice(2));

try {
  if (options.fetch) {
    await runFetch();
  } else {
    await runComparison();
  }
} catch (error) {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
}

async function runFetch() {
  const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  // 키 없이도 시도는 하지만, 무료 소스는 2026-08 기준 둘 다 막혀 있어 거의 실패합니다.
  // 조용히 타임아웃을 기다리게 두지 않고 먼저 알려줍니다.
  if (!apiKey) {
    console.warn(
      "TWELVE_DATA_API_KEY가 없습니다. Yahoo(429)·Stooq(봇 차단)만 시도하므로 대개 실패합니다.\n" +
        "  .env의 키를 쓰려면: npm run backtest:fetch",
    );
  }
  console.log(`일봉 수집: ${options.symbols.join(", ")} → ${dataDir}`);

  const { closesBySymbol, sources, failures } = await fetchAndCacheCloses({
    dataDir,
    symbols: options.symbols,
    apiKey,
  });
  for (const [symbol, source] of Object.entries(sources)) {
    // 받은 개수를 함께 찍습니다. 백테스터는 200일 워밍업을 쓰므로 개수가 곧 쓸모입니다.
    console.log(`  ${symbol}: ${closesBySymbol[symbol]?.length ?? 0}개 (출처 ${source})`);
  }
  for (const failure of failures) console.error(`  실패 — ${failure}`);

  const usable = Math.min(...Object.values(closesBySymbol).map((closes) => closes.length));
  console.log(`\n가장 짧은 종목 기준 ${usable}일 — 워밍업 200일을 빼면 ${usable - 200}일 평가 가능`);
  if (usable < 500) {
    console.warn(
      "  500일 미만이면 비교 결과가 우연과 구분되지 않습니다. outputsize 상한을 확인하십시오.",
    );
  }
}

async function runComparison() {
  const comparison = COMPARISONS[options.compare];
  if (!comparison) {
    throw new Error(
      `알 수 없는 비교: ${options.compare} (가능: ${Object.keys(COMPARISONS).join(", ")})`,
    );
  }

  const datasets = await buildDatasets();
  console.log(`\n■ ${comparison.label}`);
  console.log(
    `  데이터: ${datasets.description} | 종목 ${options.symbols.join(",")} | ` +
      `거시 상수 점수 ${options.macroScore}`,
  );

  const runVariant = (variant, sets) => sets.map((dataset) =>
    runBacktest({
      closesBySymbol: dataset.closesBySymbol,
      policy: loadTradingPolicy({ ...BASE_ENV, ...(variant.env ?? {}) }),
      macroScore: options.macroScore,
      signalOptions: variant.signal ?? {},
      ...(variant.options ?? {}),
    }).metrics,
  );

  const rows = [];
  for (const variant of comparison.variants) {
    rows.push({ 변형: variant.name, ...averageMetrics(runVariant(variant, datasets.sets)) });
  }
  console.table(rows);

  if (options.blocks > 1) {
    reportBlocks(comparison, datasets, runVariant);
  }

  console.log(
    "  주의: 합성 경로는 경로 의존 규칙의 기계적 성질만 잽니다. " +
      "신호의 예측력은 실데이터(--source cache)로만 확인할 수 있습니다.\n",
  );
}

/**
 * 표본을 겹치지 않는 구간으로 나눠 같은 비교를 반복합니다.
 *
 * 전체를 한 번만 돌리면 차이가 나와도 그것이 우연인지 알 수 없습니다. 경로가
 * 하나뿐이라 표준오차가 없기 때문입니다. 구간을 나누면 **같은 파라미터 차이가
 * 구간마다 얼마나 흔들리는지** 볼 수 있고, 그 흔들림이 곧 노이즈의 크기입니다.
 *
 * 부호가 구간마다 뒤집히면 그 차이는 방향조차 믿을 수 없다는 뜻입니다.
 */
function reportBlocks(comparison, datasets, runVariant) {
  const blocks = splitIntoBlocks(datasets.sets, options.blocks);
  if (blocks.length < 2) {
    console.log("\n  구간이 부족해 분할 비교를 건너뜁니다(구간마다 워밍업 200일이 필요합니다).");
    return;
  }

  // 첫 변형을 기준선으로 두고, 나머지의 차이가 구간마다 어떻게 흔들리는지 봅니다.
  const [baseline, ...others] = comparison.variants;
  const perBlock = blocks.map((sets) => ({
    base: averageMetrics(runVariant(baseline, sets)),
    rest: others.map((variant) => averageMetrics(runVariant(variant, sets))),
  }));

  console.log(`\n  ■ 구간 분할 (${blocks.length}구간, 기준선 = ${baseline.name})`);
  for (const key of ["CDaR5%", "MDD%", "Sharpe"]) {
    console.log(`\n  ${key} 차이 (기준선 대비, 구간별)`);
    const table = others.map((variant, index) => {
      const deltas = perBlock.map((block) => {
        const value = block.rest[index][key];
        const base = block.base[key];
        return Number.isFinite(value) && Number.isFinite(base) ? value - base : null;
      }).filter((value) => value !== null);
      if (deltas.length === 0) return { 변형: variant.name };

      const positives = deltas.filter((value) => value > 0).length;
      const row = { 변형: variant.name };
      for (const [index2, delta] of deltas.entries()) row[`구간${index2 + 1}`] = round3(delta);
      row["평균"] = round3(deltas.reduce((sum, value) => sum + value, 0) / deltas.length);
      row["폭"] = round3(Math.max(...deltas) - Math.min(...deltas));
      // 부호가 갈리면 방향조차 믿을 수 없습니다. 그것을 한 칸으로 보여줍니다.
      row["부호일치"] = positives === deltas.length || positives === 0
        ? `${deltas.length}/${deltas.length}`
        : `${Math.max(positives, deltas.length - positives)}/${deltas.length} ✗`;
      return row;
    });
    console.table(table);
  }
  console.log(
    "\n  읽는 법: 평균 차이가 구간별 폭보다 작으면 노이즈입니다. " +
      "부호일치에 ✗가 있으면 방향조차 표본에 따라 뒤집힙니다.",
  );
}

/** 각 데이터셋을 겹치지 않는 구간으로 자릅니다. 워밍업을 못 채우는 구간은 버립니다. */
function splitIntoBlocks(sets, count) {
  const minimumDays = 200 + 250; // 워밍업 200일 + 평가할 최소 구간
  const blocks = [];
  for (let index = 0; index < count; index += 1) {
    const sliced = sets.map((dataset) => {
      const closesBySymbol = {};
      for (const [symbol, closes] of Object.entries(dataset.closesBySymbol)) {
        const size = Math.floor(closes.length / count);
        closesBySymbol[symbol] = closes.slice(index * size, (index + 1) * size);
      }
      return { ...dataset, closesBySymbol };
    });
    const usable = Math.min(
      ...sliced.flatMap((dataset) =>
        Object.values(dataset.closesBySymbol).map((closes) => closes.length)),
    );
    if (usable >= minimumDays) blocks.push(sliced);
  }
  return blocks;
}

function round3(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

async function buildDatasets() {
  if (options.source === "cache") {
    const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
    const cached = await loadCachedCloses({ dataDir, symbols: options.symbols });
    if (!cached) {
      throw new Error(
        "캐시된 일봉이 없습니다. 먼저 `npm run backtest -- --fetch`를 실행하십시오.",
      );
    }
    const lengths = Object.entries(cached.closesBySymbol)
      .map(([symbol, closes]) => `${symbol} ${closes.length}`)
      .join(", ");
    const days = Math.min(...Object.values(cached.closesBySymbol).map((closes) => closes.length));
    // 상장일이 달라 길이가 다르면 짧은 쪽에 맞춰 최신 구간만 씁니다.
    // 얼마나 잘렸는지 보이지 않으면 평가 구간을 오해하게 됩니다.
    return {
      description:
        `실데이터 캐시 ${days}일 (${lengths} → 최신 ${days}일로 정렬, 수집 ${cached.fetchedAt})`,
      sets: [{ closesBySymbol: cached.closesBySymbol }],
    };
  }

  const sets = [];
  for (const scenario of options.scenarios) {
    for (let offset = 0; offset < options.seeds; offset += 1) {
      sets.push({
        closesBySymbol: buildScenario(scenario, {
          seed: options.seed + offset,
          days: options.days,
          symbols: options.symbols,
        }),
      });
    }
  }
  return {
    description:
      `합성 ${options.scenarios.length}시나리오 × 시드 ${options.seeds}개 × ${options.days}일`,
    sets,
  };
}

/** 시나리오·시드에 걸친 평균입니다. 한 경로의 우연을 결론으로 삼지 않기 위함입니다. */
function averageMetrics(results) {
  const keys = [
    "cagrPct", "annualVolPct", "sharpe", "maxDrawdownPct", "cdar5Pct",
    "averageExposurePct", "tradeCount", "turnoverPerYear", "alphaPct", "benchmarkMaxDrawdownPct",
  ];
  const averaged = {};
  for (const key of keys) {
    const values = results.map((metrics) => Number(metrics[key])).filter(Number.isFinite);
    averaged[key] = values.length
      ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000
      : null;
  }
  return {
    "CAGR%": averaged.cagrPct,
    "변동성%": averaged.annualVolPct,
    Sharpe: averaged.sharpe,
    "MDD%": averaged.maxDrawdownPct,
    // 최대낙폭은 관측 한 번이라 흔들립니다. 최악 5% 평균을 나란히 놓아
    // 결론이 침몰 한 번에 매달려 있는지 바로 보이게 합니다(Chekhlov et al. 2003).
    "CDaR5%": averaged.cdar5Pct,
    "벤치MDD%": averaged.benchmarkMaxDrawdownPct,
    "평균노출%": averaged.averageExposurePct,
    체결: Math.round(averaged.tradeCount),
    "회전율/년": averaged.turnoverPerYear,
    "alpha%": averaged.alphaPct,
  };
}

function parseArgs(argv) {
  const parsed = {
    compare: "exit",
    source: "synthetic",
    symbols: ["VTI", "SCHD", "IWM"],
    scenarios: Object.keys(SCENARIOS),
    seed: 42,
    seeds: 3,
    days: 1500,
    macroScore: 0,
    blocks: 1,
    fetch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--fetch": parsed.fetch = true; break;
      case "--compare": parsed.compare = value; index += 1; break;
      case "--source": parsed.source = value; index += 1; break;
      case "--symbols": parsed.symbols = splitCsv(value); index += 1; break;
      case "--scenario": parsed.scenarios = splitCsv(value); index += 1; break;
      case "--seed": parsed.seed = Number(value); index += 1; break;
      case "--seeds": parsed.seeds = Number(value); index += 1; break;
      case "--days": parsed.days = Number(value); index += 1; break;
      case "--macro-score": parsed.macroScore = Number(value); index += 1; break;
      case "--blocks": parsed.blocks = Number(value); index += 1; break;
      default:
        if (flag.startsWith("--")) throw new Error(`알 수 없는 옵션: ${flag}`);
    }
  }
  return parsed;
}

function splitCsv(value) {
  if (!value) throw new Error("쉼표로 구분한 값이 필요합니다.");
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
