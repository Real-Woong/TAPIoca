#!/usr/bin/env node

import { fetchMacroData } from "./fred-client.js";
import { evaluateMacroRegime } from "./macro-regime.js";

// 이 파일은 `npm run macro:status`가 실행하는 진입점입니다.
// FRED를 조회하고 결과를 출력할 뿐, PAPER 장부나 실제 계좌를 변경하지 않습니다.
try {
  // .env의 FRED_API_KEY를 사용해 모든 경제지표를 가져옵니다.
  const macroData = await fetchMacroData(process.env.FRED_API_KEY);
  // 가져온 지표에 점수를 부여해 현재 위험 상태를 계산합니다.
  const result = evaluateMacroRegime(macroData);

  console.log("\n미국 거시경제 상태");
  console.log("==================");
  console.log(`판정: ${result.regime}`);
  console.log(`점수: ${result.score}`);

  // 지표마다 value와 발표 기준일을 같은 표 형식으로 출력합니다.
  console.table({
    "연준 금리 하단": tableRow(
      result.indicators.fedTargetRange.lower,
      result.indicators.fedTargetRange.date,
    ),
    "연준 금리 상단": tableRow(
      result.indicators.fedTargetRange.upper,
      result.indicators.fedTargetRange.date,
    ),
    "근원 PCE YoY": tableRow(
      result.indicators.corePce.value,
      result.indicators.corePce.date,
    ),
    실업률: tableRow(
      result.indicators.unemployment.value,
      result.indicators.unemployment.date,
    ),
    "Sahm 지표": tableRow(
      result.indicators.sahm.value,
      result.indicators.sahm.date,
    ),
    "10Y-2Y 금리차": tableRow(
      result.indicators.yieldCurve.value,
      result.indicators.yieldCurve.date,
    ),
  });

  // 점수만 보여주지 않고 어떤 조건이 적용됐는지 함께 출력합니다.
  console.log("\n판정 근거");
  for (const reason of result.reasons) console.log(`- ${reason}`);

  // 상태에 따라 계산된 실험용 ETF/현금 목표 비중입니다.
  console.log("\n목표 비중");
  console.table(result.targetAllocation);

  console.log("\n조회 및 계산만 수행했으며 PAPER 매매에는 아직 반영하지 않았습니다.");
} catch (error) {
  // API 키, 네트워크, FRED 응답 형식 등 어느 단계에서 실패했는지 표시합니다.
  console.error(`거시경제 조회 실패: ${error.message}`);
  process.exitCode = 1;
}

// console.table()에 전달할 행의 모양을 통일합니다.
function tableRow(value, date) {
  return { value, date };
}
