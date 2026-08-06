#!/usr/bin/env node

import path from "node:path";

import { loadAlphaAttribution, worstShortfallDays } from "./alpha-attribution.js";

// alpha를 설계된 차이와 결함으로 인한 이탈로 나눠 보여줍니다. 매매는 하지 않습니다.
const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const result = await loadAlphaAttribution(dataDir);

if (!result.totals) {
  console.log(
    `분해할 이벤트가 부족합니다 (사용 가능 ${result.sampleSize}건, 최소 2건). ` +
      "먼저 npm run paper:run을 실행하세요.",
  );
} else {
  const { totals } = result;
  console.log(`${result.from} ~ ${result.to} · 사이클 ${result.sampleSize}건\n`);
  console.log(`실제 alpha: ${usd(result.alphaUsd)}\n`);
  console.log("항목별 기여");
  console.log(`  구조적 현금 드래그   ${usd(totals.structuralUsd)}  ← 설계. 목표 현금 비중의 대가`);
  console.log(`  목표 미달 이탈       ${usd(totals.shortfallUsd)}  ← 결함. 목표를 못 채운 구간`);
  console.log(
    `  종목선택·구간내매매  ${usd(totals.selectionUsd)}  ← VTI 대신 SCHD·IWM + 사이클 안 매매`,
  );
  console.log(`  거래비용             ${usd(-totals.feesUsd)}  ← 누적 수수료`);
  console.log(`  복리 잔차            ${usd(totals.compoundingUsd)}  ← 분해 오차`);

  // 잔차가 다른 항목만큼 크면 분해를 믿으면 안 됩니다. 그 사실을 먼저 알립니다.
  const largest = Math.max(
    Math.abs(totals.structuralUsd), Math.abs(totals.shortfallUsd), Math.abs(totals.selectionUsd),
  );
  if (largest > 0 && Math.abs(totals.compoundingUsd) > largest * 0.5) {
    console.log(
      "\n⚠️ 복리 잔차가 최대 항목의 절반을 넘습니다. 이 분해는 신뢰할 수 없습니다.",
    );
  }

  const diagnosis = Math.abs(totals.shortfallUsd) > Math.abs(totals.structuralUsd)
    ? "목표 미달이 더 큽니다 → 체결·재투입 경로의 문제입니다. 고칠 대상입니다."
    : "구조적 드래그가 더 큽니다 → 설계대로입니다. 목표 현금 비중을 바꿔야 움직입니다.";
  console.log(`\n판정: ${diagnosis}`);

  console.log("\n초과성과가 가장 나빴던 날");
  console.log("거래일        초과성과    목표미달   구조적");
  for (const day of worstShortfallDays(result.steps)) {
    console.log(
      `${day.day}  ${pad(usd(day.excessUsd), 9)} ${pad(usd(day.shortfallUsd), 10)} ` +
        `${pad(usd(day.structuralUsd), 8)}`,
    );
  }
  console.log("\n주의: 세 항목 모두 벤치마크 수익률에 비례합니다. 시장이 오르면 현금은 손해,");
  console.log("내리면 이득입니다. alpha가 음수라는 사실만으로 결함을 뜻하지 않습니다.");
}

function usd(value) {
  const number = Number(value);
  return `${number >= 0 ? "+" : "-"}$${Math.abs(number).toFixed(2)}`;
}

function pad(text, width) {
  return String(text).padStart(width);
}
