#!/usr/bin/env node

import path from "node:path";

import { loadCachedCloses } from "./price-cache.js";

/**
 * **추세 신호가 "방어자산이 도움 되는 국면"과 "해로운 국면"을 구분하는가.**
 *
 * ver2의 스위칭 가설에는 전제가 하나 있습니다 — 200일선이 하방을 가리킬 때
 * 방어자산으로 갈아타면 낫다는 것. 그런데 2026-08-21의 정적 비교에서 방어자산은
 * **2008(구간1)에서 벌고 2022(구간4)에서 잃었습니다.** 두 시기 모두 주식이
 * 빠졌으므로 추세는 둘 다 하방을 가리켰을 것입니다.
 *
 * **그렇다면 추세로는 두 국면을 못 가릅니다.** 그러면 aggregator를 아무리 잘
 * 만들어도 소용이 없습니다 — 신호가 구분하지 못하는 것을 배분이 구분할 수는
 * 없습니다. 그것을 aggregator를 만들기 **전에** 확인합니다.
 *
 *   npm run diagnose:defensive
 *   npm run diagnose:defensive -- --horizon 20 --symbols VTI,IEF,GLD,TLT
 *
 * 백테스트가 아닙니다. 매매도 비용도 없고, **신호가 켜진 날의 자산 수익률**만
 * 셉니다. 규칙을 끼워 넣지 않아야 규칙 탓인지 신호 탓인지 갈립니다.
 */

const MA_PERIOD = 200;
const DEVIATION_SCALE_PERCENT = 5;

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
// 신호를 만드는 자산과, 그 신호가 켜졌을 때 갈아탈 후보들입니다.
const trendSymbol = readArg("--trend", "VTI");
const symbols = readArg("--symbols", "VTI,IEF,GLD,TLT").split(",").map((s) => s.trim());
// 며칠을 들고 있을 것인가. 15분 사이클이지만 배분은 며칠 단위로 유지됩니다.
const horizon = Number(readArg("--horizon", "20"));
// 이길 대상은 0%가 아니라 **현금**입니다. 백테스터가 현금을 0%로 보는 것이
// 편향이었던 것과 같은 이유입니다(⑮ 이후). 기본값은 T-bill 20년 평균 근사입니다.
const cashYield = Number(readArg("--cash-yield", "0.017"));
const cashOverHorizon = (cashYield / 252) * horizon * 100;

const cached = await loadCachedCloses({ dataDir, symbols });
if (!cached) {
  console.error("캐시된 일봉이 없습니다. 먼저: npm run backtest:fetch -- --symbols " + symbols.join(","));
  process.exitCode = 1;
} else {
  main(cached);
}

function main(cached) {
  // 종목마다 길이가 다르면 **뒤에서** 맞춥니다(blocks.js와 같은 규칙).
  const length = Math.min(...symbols.map((s) => cached.closesBySymbol[s].length));
  const closes = Object.fromEntries(
    symbols.map((s) => [s, cached.closesBySymbol[s].slice(-length)]),
  );
  const shortest = symbols.reduce((a, b) =>
    cached.closesBySymbol[a].length <= cached.closesBySymbol[b].length ? a : b);
  const dates = (cached.datesBySymbol?.[shortest] ?? []).slice(-length);

  console.log(
    `\n■ 추세가 방어 국면을 구분하는가 — 신호 ${trendSymbol} 200일선 · 보유 ${horizon}거래일`,
  );
  console.log(
    `  실데이터 ${length}일` +
      `${dates.length ? ` (${dates[0]} ~ ${dates[dates.length - 1]})` : ""} · 매매도 비용도 없음\n`,
  );

  // 하루씩: 그날의 추세 점수와, 그날부터 horizon일 뒤까지의 각 자산 수익률.
  const rows = [];
  for (let index = MA_PERIOD - 1; index + horizon < length; index += 1) {
    const window = closes[trendSymbol].slice(index + 1 - MA_PERIOD, index + 1);
    const movingAverage = window.reduce((sum, v) => sum + v, 0) / window.length;
    const deviationPercent = (closes[trendSymbol][index] / movingAverage - 1) * 100;
    const score = Math.tanh(deviationPercent / DEVIATION_SCALE_PERCENT);
    const forward = {};
    for (const symbol of symbols) {
      forward[symbol] = (closes[symbol][index + horizon] / closes[symbol][index] - 1) * 100;
    }
    rows.push({ index, date: dates[index] ?? null, score, forward });
  }

  // ── 1. 구간 × 추세부호 ───────────────────────────────────────────────
  // 백테스트의 `--blocks 4`와 같은 자리에서 자릅니다. 그래야 방금 본 표와
  // 같은 국면을 가리킵니다.
  const blockSize = Math.floor(length / 4);
  console.log("── 구간별: 추세가 하방(score < 0)인 날의 평균 " + horizon + "일 수익률(%) ──\n");
  header();
  for (let block = 0; block < 4; block += 1) {
    const from = block * blockSize;
    const to = (block + 1) * blockSize;
    const inBlock = rows.filter((r) => r.index >= from && r.index < to);
    printGroup(`구간${block + 1}`, inBlock, dates[from], dates[Math.min(to, length) - 1]);
  }

  console.log("\n── 전체 표본 ──\n");
  header();
  printGroup("전체", rows);

  // ── 2. 판정 ──────────────────────────────────────────────────────────
  console.log(
    "\n  (주의) 하루씩 굴린 " + horizon + "일 수익률이라 날끼리 겹칩니다. 날 수는 표본 수가\n" +
      "  아닙니다. 판정은 겹치지 않는 **구간 4개의 부호**로만 합니다.",
  );
  console.log("\n── 판정 ──\n");
  const down = (list) => list.filter((r) => r.score < 0);
  const mean = (list, symbol) =>
    list.length ? list.reduce((sum, r) => sum + r.forward[symbol], 0) / list.length : NaN;

  const defensive = symbols.filter((s) => s !== trendSymbol);
  for (const symbol of defensive) {
    const perBlock = [];
    for (let block = 0; block < 4; block += 1) {
      const inBlock = down(rows.filter(
        (r) => r.index >= block * blockSize && r.index < (block + 1) * blockSize));
      perBlock.push(mean(inBlock, symbol));
    }
    const positives = perBlock.filter((v) => v > cashOverHorizon).length;
    console.log(
      `  ${symbol.padEnd(5)} 추세 하방일의 수익률: ` +
        perBlock.map((v) => (Number.isFinite(v) ? v.toFixed(2) : "  —").padStart(7)).join(" ") +
        `   현금초과 ${positives}/4` +
        (positives === 4 ? "  ← 국면과 무관하게 이겼다" : "  ← 국면이 정한다"),
    );
  }
  console.log(
    `\n  기준은 같은 기간의 현금 ${cashOverHorizon.toFixed(2)}%입니다(연 ${(cashYield * 100).toFixed(1)}%).\n` +
      "  **현금초과 4/4가 아니면 추세만으로는 갈아탈 곳을 정할 수 없습니다.**\n" +
      "  같은 '하방' 신호에 어떤 구간에서는 벌고 어떤 구간에서는 잃는다면,\n" +
      "  그 구분은 추세 안에 들어 있지 않은 것입니다. aggregator로도 못 만듭니다.",
  );
}

function header() {
  console.log(
    "  " + "구간".padEnd(8) + "기간".padEnd(26) + "날수(하방/전체)".padEnd(18) +
      symbols.map((s) => s.padStart(8)).join(""),
  );
}

function printGroup(label, list, from, to) {
  const down = list.filter((r) => r.score < 0);
  const mean = (symbol) =>
    down.length ? down.reduce((sum, r) => sum + r.forward[symbol], 0) / down.length : NaN;
  const span = from && to ? `${from} ~ ${to}` : "";
  console.log(
    "  " + label.padEnd(8) + span.padEnd(26) +
      `${down.length}/${list.length}`.padEnd(18) +
      symbols.map((s) => (Number.isFinite(mean(s)) ? mean(s).toFixed(2) : "—").padStart(8)).join(""),
  );
}
