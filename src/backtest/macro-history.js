import { evaluateMacroRegime } from "../FRED_data/macro-regime.js";

/**
 * 과거 어느 날 거시 층이 **그때 알 수 있었던 것만으로** 어떤 점수를 냈을지
 * 되살립니다.
 *
 * 왜 따로 만드는가 — FRED가 기본으로 주는 값은 **개정된** 값입니다. 2008년 9월의
 * 실업률을 지금 조회하면 그때는 아무도 몰랐던 확정치가 옵니다. 그대로 백테스트에
 * 넣으면 미래를 보고 매매한 것이 되고, 거시 층은 실제보다 훨씬 똑똑해 보입니다.
 * 이 실수는 결과가 좋게 나오기 때문에 눈에 띄지 않습니다.
 *
 * 그래서 vintage(개정 이력)를 받습니다. 관측마다 `realtimeStart`가 함께 오는데,
 * 그것이 **그 값이 세상에 알려진 날**입니다. as-of 날짜보다 늦게 알려진 값은
 * 그날의 판단에서 빼야 합니다.
 *
 * 발표 지연도 이것으로 함께 처리됩니다. 실업률 9월치는 10월 초에 나오므로
 * 9월 중순에는 8월치가 최신입니다. `realtimeStart`로 거르면 그 사정이 저절로
 * 반영되고, 우리가 지표별 발표 일정을 따로 적어둘 필요가 없습니다.
 */

/**
 * as-of 시점에 알려져 있던 관측만 남깁니다.
 *
 * `evaluateMacroRegime`은 `observations[0]`을 최신값으로 읽고 인덱스로 과거를
 * 세므로(3개월 전 = `observations[3]`), 반환 배열은 **날짜 내림차순**이어야 하고
 * 같은 날짜에 여러 개정본이 있으면 **그중 가장 최근에 알려진 것 하나**만 남아야
 * 합니다. 둘 중 하나라도 어긋나면 조용히 틀린 값을 계산합니다.
 */
export function observationsAsOf(observations, asOfDate) {
  const asOf = toDateString(asOfDate);
  const latestByDate = new Map();

  for (const observation of observations ?? []) {
    // realtimeStart가 없으면 vintage 없이 받은 데이터입니다. 그때가 언제
    // 알려졌는지 알 수 없으므로 되살리기에 쓸 수 없습니다.
    const knownAt = observation.realtimeStart;
    if (!knownAt || knownAt > asOf) continue;

    const previous = latestByDate.get(observation.date);
    // 같은 관측일의 개정본이 여럿이면 as-of 이전에 알려진 것 중 가장 나중 것을 씁니다.
    if (!previous || knownAt > previous.realtimeStart) {
      latestByDate.set(observation.date, observation);
    }
  }

  return [...latestByDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * 원지수를 전년 대비 변화율(%)로 바꿉니다. FRED의 `units=pc1`과 같은 계산입니다.
 *
 * **왜 우리가 계산하는가** — FRED는 `units`가 `lin`이 아니면 개정 이력을 함께
 * 주지 않습니다(realtime 범위를 하루로 고정하라고 400을 냅니다). 그래서 원지수를
 * 개정 이력으로 받고 변환은 여기서 합니다.
 *
 * **그리고 이 순서가 더 정확합니다.** 변환을 as-of 필터 **뒤에** 하므로, 전년
 * 대비를 구할 때 쓰는 12개월 전 값도 그 시점에 알려져 있던 값입니다. FRED가
 * 계산해 준 pc1을 썼다면 개정된 과거 값이 분모에 섞였을 것입니다.
 *
 * 관측은 날짜 내림차순이므로 12칸 뒤가 1년 전입니다. 1년치가 없는 구간은
 * 계산할 수 없으므로 버립니다 — 워밍업에서 `evaluateMacroRegime`이 예외를
 * 던지고 그 날은 null이 됩니다.
 */
export function toYearOverYear(observations) {
  const result = [];
  for (let index = 0; index + 12 < observations.length; index += 1) {
    const current = observations[index];
    const yearAgo = observations[index + 12];
    if (!(yearAgo.value > 0)) continue;
    result.push({ ...current, value: (current.value / yearAgo.value - 1) * 100 });
  }
  return result;
}

/** `evaluateMacroRegime`이 기대하는 `{ series: { key: { observations } } }` 모양으로 만듭니다. */
export function macroDataAsOf(vintages, asOfDate) {
  const series = {};
  for (const [key, item] of Object.entries(vintages.series ?? {})) {
    // 순서가 중요합니다. **먼저 그날 알 수 있었던 것만 남기고, 그 다음에
    // 변환합니다.** 뒤집으면 개정된 미래 값이 분모로 들어옵니다.
    const known = observationsAsOf(item.observations, asOfDate);
    series[key] = {
      ...item,
      observations: item.transform === "pc1" ? toYearOverYear(known) : known,
    };
  }
  return { fetchedAt: toDateString(asOfDate), series };
}

/**
 * 백테스트 날짜 배열에 맞춰 거시 점수 시계열을 만듭니다.
 *
 * 워밍업 구간에는 지표 이력이 모자라 `evaluateMacroRegime`이 예외를 던집니다.
 * 그때는 **0을 쓰지 않고 null을 넣습니다.** 0은 "중립"이라는 판단인데 실제로는
 * "모른다"이고, 둘을 같은 값으로 적으면 나중에 구분할 수 없습니다. 호출부가
 * null을 보고 그 구간을 어떻게 다룰지 정합니다.
 */
export function macroScoreTimeline(vintages, dates) {
  return dates.map((date) => {
    try {
      return evaluateMacroRegime(macroDataAsOf(vintages, date), toDate(date)).score;
    } catch {
      return null;
    }
  });
}

/** 되살린 점수가 실제로 움직이는지 보는 요약입니다. 안 움직이면 신호가 아니라 상수입니다. */
export function summarizeMacroTimeline(scores) {
  const known = scores.filter((score) => score !== null);
  if (known.length === 0) return { count: 0 };
  const mean = known.reduce((sum, score) => sum + score, 0) / known.length;
  const changes = known.slice(1).map((score, index) => Math.abs(score - known[index]));
  return {
    count: known.length,
    unknown: scores.length - known.length,
    mean: round(mean),
    min: Math.min(...known),
    max: Math.max(...known),
    stdev: round(Math.sqrt(known.reduce((sum, s) => sum + (s - mean) ** 2, 0) / known.length)),
    // 값이 바뀐 날의 비율. 월간 지표가 입력이므로 낮은 것이 정상이고,
    // 0이면 되살리기가 실패했거나 이 층이 표본 내내 상수였다는 뜻입니다.
    changeDays: changes.filter((change) => change > 0).length,
    meanAbsChange: changes.length ? round(average(changes)) : null,
  };
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

function toDate(value) {
  return value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
}

function toDateString(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
