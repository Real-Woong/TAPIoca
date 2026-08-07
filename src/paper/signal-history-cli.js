#!/usr/bin/env node

import path from "node:path";

import { loadSignalHistory } from "./signal-history.js";

// 이벤트 로그에 쌓인 감성 스냅샷을 표와 통계로 보여줍니다. 매매는 하지 않습니다.
// --json 을 주면 백테스트에 바로 먹일 수 있는 일별 시계열만 출력합니다.
const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const asJson = process.argv.includes("--json");
const daily = process.argv.includes("--daily");

const history = await loadSignalHistory(dataDir);

if (asJson) {
  console.log(JSON.stringify(daily ? history.daily : history.series, null, 2));
} else if (history.series.length === 0) {
  console.log(
    history.eventCount === 0
      ? "기록된 이벤트가 없습니다. 먼저 npm run paper:run을 실행하세요."
      : `이벤트 ${history.eventCount}건에 원본 신호가 없습니다. ` +
        "원본 신호 기록은 이번 배포부터 쌓이므로 다음 정규장 이후 다시 확인하세요.",
  );
} else {
  const rows = daily ? history.daily : history.series;
  console.log(
    `감성 스냅샷 ${history.series.length}건 ` +
      `(이벤트 ${history.eventCount}건 중 원본 신호 ${history.withSignals}건)\n`,
  );
  console.log("수집시각              거래일        원점수   신뢰도  기사수  기여도  통합점수");
  for (const row of rows) {
    console.log(
      `${row.fetchedAt.slice(0, 16).replace("T", " ")}  ${row.tradingDate}  ` +
        `${pad(row.score, 7)} ${pad(row.confidence, 7)} ${pad(row.articleCount, 6)} ` +
        `${pad(row.contribution, 7)} ${pad(row.combinedScore, 8)}`,
    );
  }

  const { summary, snapshotSummary } = history;
  console.log(
    `\n${summary.firstDate} ~ ${summary.lastDate} · 거래일 ${summary.count}일 · ` +
      `스냅샷 ${snapshotSummary.count}건`,
  );
  console.log(
    `평균 ${summary.mean} · 표준편차 ${summary.stdev} · 범위 ${summary.min}~${summary.max}`,
  );
  console.log(`일간 평균 변동폭 ${summary.meanAbsChange} · 부호 반전 ${summary.signFlips}회`);

  // 판정은 일별입니다. 스냅샷 단위(1시간 간격)는 같은 뉴스 사이클 안이라
  // 자기상관이 부풀려지고, 간격도 고르지 않습니다. 참고로만 함께 냅니다.
  if (snapshotSummary.autocorrelation !== null) {
    console.log(`(참고) 스냅샷 단위 자기상관: ${snapshotSummary.autocorrelation} — 판정에 쓰지 않습니다.`);
  }

  // **자기상관보다 먼저 보는 관문입니다.** 멈춘 값은 자기상관이 1에 가까워
  // "값이 이어진다"로 읽히는데, 그것은 고장을 신호로 읽는 것입니다.
  if (summary.stuck) {
    console.log(
      `\n⚠️  값이 멈춰 있습니다 — 표준편차 ${summary.stdev}, 서로 다른 값 ` +
        `${summary.distinctValues}개 / ${summary.count}일.\n` +
        "   이 상태로는 자기상관을 판정에 쓸 수 없습니다. 멈춘 값은 자기상관이\n" +
        "   1에 가까워 '정보를 담고 있다'는 정반대 결론으로 읽힙니다.\n" +
        "   먼저 수집이 살아 있는지 보십시오: npm run sentiment:status");
  }

  if (summary.autocorrelation === null) {
    console.log(
      `1차 자기상관(일별): 표본 부족 (${summary.count}/10거래일) — 최소 10거래일은 모여야 계산합니다.`,
    );
  } else {
    console.log(`1차 자기상관(일별): ${summary.autocorrelation}`);
    if (summary.stuck) {
      console.log("→ **판정 보류.** 값이 멈춰 있어 이 숫자는 지속성이 아니라 고장을 잽니다.");
    } else {
    // 판정 기준을 코드에 박아 두면 나중에 눈대중으로 해석이 흔들리지 않습니다.
    console.log(
      summary.autocorrelation >= 0.3
        ? "→ 값이 이어집니다. 정보를 담고 있을 가능성이 있어 가중치를 유지할 근거가 됩니다."
        : summary.autocorrelation <= 0.1
          ? "→ 매일 새로 뽑히는 값과 구분되지 않습니다. 가중치 축소나 평활을 검토하세요."
          : "→ 판단하기 애매합니다. 표본을 더 모으세요.",
      );
    }
  }
  console.log("\n전체 원본: data/paper-events.jsonl · 백테스트용 내보내기: --json --daily");
}

function pad(value, width) {
  if (value === null || value === undefined) return "-".padStart(width);
  // 부동소수 잔여( 0.15059999999999998 )가 표를 깨뜨리지 않도록 자릿수를 고정합니다.
  const text = Number.isFinite(Number(value)) && !Number.isInteger(Number(value))
    ? Number(value).toFixed(4)
    : String(value);
  return text.padStart(width);
}
