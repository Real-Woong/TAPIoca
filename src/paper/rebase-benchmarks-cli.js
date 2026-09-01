#!/usr/bin/env node

/**
 * 이미 열려 있는 기준선을 **개설일의 지갑 자산 규모로 다시 잽니다** — ⑰의 (a)안.
 *
 *   npm run paper:rebase              무엇이 바뀌는지 보여주기만 한다
 *   npm run paper:rebase -- --confirm 실제로 고친다
 *
 * **왜 필요한가.** 기준선은 개설일에 `funding.fundedUsd`(원금 전액)가 들어간
 * 것으로 잡혔는데, 기준선은 지갑보다 늦게 열립니다 — VTI는 07-27, 정책믹스는
 * 08-06인데 지갑은 07-14입니다. 그 사이에 지갑은 이미 움직여 있었으므로
 * (07-27에 $66.71 대 원금 $67.05) **초과성과가 규모가 다른 둘을 뺐습니다.**
 * 기준선은 0.5% 큰 자본으로 벌고 잃습니다.
 *
 * `paper-engine.js`의 `benchmarkCapital`이 앞으로 열릴 기준선을 고치지만, 이미
 * 열린 둘은 저절로 고쳐지지 않습니다. 이 명령이 그 둘을 한 번 다시 잽니다.
 *
 * **가격을 다시 구하지 않습니다.** 기준선의 모든 값은 원금에 선형이므로
 * (수량 = 원금 × 비중 × (1−비용) / 진입가), 원금 비율만큼 수량과 현금을 줄이면
 * **같은 진입가로 더 작은 원금을 넣은 것과 정확히 같습니다.** 진입가를
 * 역산하거나 시세를 다시 부를 이유가 없고, 그래서 이 명령은 네트워크를 쓰지
 * 않습니다.
 *
 * **두 번 돌려도 안전합니다.** 기준선의 원금이 이미 앵커와 같으면 건드리지
 * 않습니다. 표식을 따로 두지 않는 이유는, 표식은 실제 상태와 어긋날 수 있지만
 * 이 비교는 상태 자체를 보기 때문입니다.
 *
 * **앵커를 못 찾으면 그 기준선은 건드리지 않습니다.** 그 경우 보고서는 이미
 * 초과성과를 "계산 안 함"으로 내고 있으므로, 손대지 않는 것이 일관됩니다.
 */

import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { summarizePaperState, walletEquityAtBenchmarkStart } from "./paper-engine.js";

const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const statePath = path.join(dataDir, "paper-state.json");

/** 원금이 앵커와 이만큼 안쪽이면 이미 맞은 것으로 봅니다. 반 센트입니다. */
const ALIGNED_USD = 0.005;

const line = (label, value) => console.log(`  ${String(label).padEnd(24)} ${value}`);
const usd = (n) => `$${Number(n).toFixed(4)}`;
const signed = (n) => `${Number(n) >= 0 ? "+" : "-"}$${Math.abs(Number(n)).toFixed(4)}`;

/** 저장된 마지막 가격만으로 기준선 평가액을 냅니다. 시세를 부르지 않습니다. */
function benchmarkValue(benchmark) {
  const price = Number(benchmark.lastPrice) || Number(benchmark.entryPriceUsd);
  return Number(benchmark.quantity) * price;
}

function policyValue(benchmark) {
  let value = Number(benchmark.cashUsd) || 0;
  for (const position of Object.values(benchmark.positions ?? {})) {
    value += Number(position.quantity) * Number(position.lastPrice);
  }
  return value;
}

/**
 * 기준선 하나를 검사하고, 고칠 것이 있으면 고칩니다.
 *
 * `apply`가 false면 아무것도 바꾸지 않고 무엇이 바뀔지만 돌려줍니다. 같은
 * 계산을 두 번 쓰지 않으려고 한 함수에 뒀습니다 — 미리보기와 실제가 갈리면
 * 확인의 의미가 없습니다.
 */
function rebase(state, benchmark, valueOf, scale, { apply }) {
  const anchor = walletEquityAtBenchmarkStart(state, benchmark);
  if (!anchor) return { status: "NO_ANCHOR" };

  const before = Number(benchmark.fundedUsd);
  const target = anchor.equityUsd;
  if (!(before > 0)) return { status: "NO_CAPITAL" };
  if (Math.abs(before - target) < ALIGNED_USD) return { status: "ALIGNED", fundedUsd: before };

  const factor = target / before;
  const pnlBefore = valueOf(benchmark) - before;
  const pnlAfter = pnlBefore * factor;

  if (apply) {
    scale(benchmark, factor);
    benchmark.fundedUsd = target;
    benchmark.walletEquityUsdAtStart = target;
    // 소급해서 채운 값이면 그 사실을 남깁니다. 이 값은 개설 시각이 아니라
    // 그날 첫 사이클 직전의 자산이라, 보고서가 "개설일 시작 자산 기준"이라고
    // 적어야 정직합니다.
    benchmark.walletEquityUsdAtStartSource = anchor.source;
    benchmark.rebasedAt = new Date().toISOString();
  }

  return {
    status: "REBASED",
    source: anchor.source,
    factor,
    fundedBefore: before,
    fundedAfter: target,
    pnlBefore,
    pnlAfter,
    anchorEquityUsd: target,
  };
}

function report(label, result, equityUsd) {
  console.log(`\n■ ${label}`);
  if (result.status === "NO_ANCHOR") {
    line("건너뜀", "개설일 지갑 자산을 모릅니다 — 보고서도 초과성과를 안 냅니다");
    return;
  }
  if (result.status === "NO_CAPITAL") {
    line("건너뜀", "기준선 원금이 없습니다");
    return;
  }
  if (result.status === "ALIGNED") {
    line("이미 맞습니다", usd(result.fundedUsd));
    return;
  }

  line("앵커 출처", result.source === "OPEN" ? "개설 시 기록" : "그날 시작 자산(소급)");
  line("원금", `${usd(result.fundedBefore)} → ${usd(result.fundedAfter)}`);
  line("배수", result.factor.toFixed(8));
  line("기준선 손익", `${signed(result.pnlBefore)} → ${signed(result.pnlAfter)}`);
  // 초과성과는 겹치는 구간에서만 뺍니다. 앵커가 그 시작점입니다.
  const alphaBefore = (equityUsd - result.anchorEquityUsd) - result.pnlBefore;
  const alphaAfter = (equityUsd - result.anchorEquityUsd) - result.pnlAfter;
  line("초과성과", `${signed(alphaBefore)} → ${signed(alphaAfter)}`);
}

async function main() {
  console.log(`\n기준선 규모 재조정 (⑰ (a)안) — ${statePath}\n`);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  const equityUsd = summarizePaperState(state).equityUsd;
  line("지갑 자산(지금)", usd(equityUsd));
  line("투입 원금", usd(state.funding?.fundedUsd));
  line("모드", confirm ? "저장합니다" : "미리보기 (저장하려면 --confirm)");

  const results = [];

  if (state.benchmark) {
    results.push(rebase(
      state,
      state.benchmark,
      benchmarkValue,
      (benchmark, factor) => { benchmark.quantity *= factor; },
      { apply: confirm },
    ));
    report(`VTI 기준선 (${state.benchmark.symbol} · ${state.benchmark.startedAt?.slice(0, 10)})`,
      results.at(-1), equityUsd);
  } else {
    console.log("\n■ VTI 기준선 — 없습니다");
  }

  if (state.policyBenchmark) {
    results.push(rebase(
      state,
      state.policyBenchmark,
      policyValue,
      (benchmark, factor) => {
        for (const position of Object.values(benchmark.positions ?? {})) position.quantity *= factor;
        benchmark.cashUsd = Math.round(benchmark.cashUsd * factor * 100) / 100;
      },
      { apply: confirm },
    ));
    report(`정책믹스 기준선 (${state.policyBenchmark.startedAt?.slice(0, 10)})`,
      results.at(-1), equityUsd);
  } else {
    console.log("\n■ 정책믹스 기준선 — 없습니다");
  }

  const changed = results.filter((result) => result.status === "REBASED").length;
  if (!changed) {
    console.log("\n고칠 것이 없습니다.\n");
    return;
  }
  if (!confirm) {
    console.log(`\n${changed}건을 고칠 수 있습니다. 실제로 고치려면:`);
    console.log("  npm run paper:rebase -- --confirm\n");
    return;
  }

  // 원본을 먼저 복사해 둡니다. **PAPER 장부를 손대는 유일한 작업**이고,
  // 이 파일이 실험 전체의 기록입니다. 되돌릴 길 없이 덮어쓰지 않습니다.
  const backupPath = `${statePath}.bak-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  await copyFile(statePath, backupPath);

  // 장부 저장과 같은 방식입니다 — 임시 파일을 완성한 뒤 rename합니다.
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statePath);

  console.log(`\n${changed}건을 고쳤습니다.`);
  line("원본 백업", backupPath);
  console.log("");
}

main().catch((error) => {
  if (error.code === "ENOENT") {
    console.error(`PAPER 장부가 없습니다: ${statePath}`);
  } else {
    console.error(`오류: ${error.message}`);
  }
  process.exitCode = 1;
});
