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
 *   npm run backtest -- --fetch           실데이터 일봉을 받아 캐시에 저장
 *   npm run backtest -- --source cache    캐시된 실데이터로 실행
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

/**
 * 누적 손실 브레이크는 한 번 걸리면 스스로 풀리지 않습니다.
 * 매수는 멈추는데 리밸런싱 매도는 계속 돌아 자산이 현금으로 빠지고,
 * 현금 상태에서는 자산이 회복될 수 없어 잠금이 영구화됩니다.
 * 신호 비교 실험에서는 이 잠금이 모든 변형을 똑같이 0%로 만들어 버리므로
 * 기본적으로 풀어 두고, 브레이크 자체를 재려면 --max-total-loss로 지정합니다.
 */
const NO_BRAKE_USD = "100000";

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
      `거시 상수 점수 ${options.macroScore} | ` +
      `누적손실 브레이크 ${options.maxTotalLoss ? `$${options.maxTotalLoss}` : "해제"}`,
  );

  const rows = [];
  for (const variant of comparison.variants) {
    const results = datasets.sets.map((dataset) =>
      runBacktest({
        closesBySymbol: dataset.closesBySymbol,
        policy: loadTradingPolicy({
          ...BASE_ENV,
          MAX_TOTAL_LOSS_USD: options.maxTotalLoss ?? NO_BRAKE_USD,
          ...(variant.env ?? {}),
        }),
        macroScore: options.macroScore,
        signalOptions: variant.signal ?? {},
      }).metrics,
    );
    rows.push({ 변형: variant.name, ...averageMetrics(results) });
  }

  console.table(rows);
  console.log(
    "  주의: 합성 경로는 경로 의존 규칙의 기계적 성질만 잽니다. " +
      "신호의 예측력은 실데이터(--source cache)로만 확인할 수 있습니다.\n",
  );
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
    "cagrPct", "annualVolPct", "sharpe", "maxDrawdownPct",
    "averageExposurePct", "tradeCount", "turnoverPerYear", "alphaPct",
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
    maxTotalLoss: undefined,
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
      case "--max-total-loss": parsed.maxTotalLoss = value; index += 1; break;
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
