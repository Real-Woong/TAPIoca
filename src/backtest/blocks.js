/**
 * 표본을 겹치지 않는 구간으로 자릅니다. §3의 부호일치 판정이 쓰는 도구입니다.
 *
 * **자르기 전에 먼저 정렬합니다.** 종목마다 상장일이 달라 길이가 다른데, 각자
 * `길이 / 구간수`로 자르면 **같은 구간 번호가 종목마다 다른 날짜를 가리킵니다** —
 * VTI(5000일)의 구간1은 2008년인데 SCHD(3719일)의 구간1은 2013년이 됩니다.
 * 그 상태로 나온 구간별 차이는 아무것도 재지 않은 값입니다.
 *
 * 2026-08-21에 `--compare regime --source cache --blocks 4`(3종목)가 이것을
 * 밟았습니다. 증상은 마지막 구간에서 난 크래시였습니다 — `dates`는 가장 짧은
 * 종목 기준(3719)인데 자르는 폭은 마지막 종목 기준(1250)이라 구간4가
 * `slice(3750, 5000)` = **빈 배열**이 되고, 엔진이 `timeline[index].toISOString()`
 * 에서 undefined를 만났습니다. **터진 것은 구간4뿐이고 구간1~3은 조용히 틀린
 * 값을 냈습니다.** 그쪽이 더 위험합니다.
 */

/** 워밍업 200일 + 평가할 최소 구간 250일. 이보다 짧은 구간은 버립니다. */
export const MINIMUM_BLOCK_DAYS = 450;

/**
 * 모든 종목을 가장 짧은 종목 길이에 맞춰 **뒤에서** 자릅니다.
 *
 * 뒤에서 자르는 이유는 배열이 오래된 순이고 같은 날짜에서 끝나기 때문입니다.
 * 앞에서 자르면 VTI의 2006년과 SCHD의 2011년이 같은 인덱스에 옵니다.
 */
export function alignToShortest(closesBySymbol) {
  const entries = Object.entries(closesBySymbol ?? {});
  if (entries.length === 0) return { length: 0, closesBySymbol: {} };
  const length = Math.min(...entries.map(([, closes]) => closes.length));
  return {
    length,
    closesBySymbol: Object.fromEntries(
      entries.map(([symbol, closes]) => [symbol, closes.slice(-length)]),
    ),
  };
}

export function splitIntoBlocks(sets, count, minimumDays = MINIMUM_BLOCK_DAYS) {
  const blocks = [];
  for (let index = 0; index < count; index += 1) {
    const sliced = sets.map((dataset) => {
      const { length, closesBySymbol } = alignToShortest(dataset.closesBySymbol);
      // 정렬한 뒤라 폭은 하나뿐입니다. 종목마다 다른 폭을 쓸 여지를 남기지 않습니다.
      const size = Math.floor(length / count);
      const from = index * size;
      const to = (index + 1) * size;
      // 날짜와 거시 점수도 **정렬한 뒤 같은 자리에서** 잘라야 합니다. 종가만
      // 자르고 나머지를 전체 길이로 두면 구간 인덱스가 엉뚱한 날을 가리킵니다.
      // 2026-08-07에 실제로 그랬습니다 — 되살린 거시가 뒤쪽 1738일에만 있는데
      // 구간 길이가 1250이라 모든 구간이 null로 떨어져 상수와 같아졌고,
      // 구간 차이가 정확히 0으로 찍혀 "차이가 없다"처럼 보였습니다.
      const slice = (array) =>
        Array.isArray(array) ? array.slice(-length).slice(from, to) : array;
      return {
        ...dataset,
        closesBySymbol: Object.fromEntries(
          Object.entries(closesBySymbol).map(([symbol, closes]) => [symbol, closes.slice(from, to)]),
        ),
        dates: slice(dataset.dates),
        macroScores: slice(dataset.macroScores),
      };
    });
    const usable = Math.min(
      ...sliced.flatMap((dataset) =>
        Object.values(dataset.closesBySymbol).map((closes) => closes.length)),
    );
    if (usable >= minimumDays) blocks.push(sliced);
  }
  return blocks;
}
