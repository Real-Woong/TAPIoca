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

/**
 * 실업률에서 Sahm 경기침체 지표를 직접 계산합니다.
 *
 *   Sahm = (실업률 3개월 이동평균) − (직전 12개월 중 3개월 이동평균의 최저값)
 *
 * **왜 직접 계산하는가** — `SAHMREALTIME`은 Claudia Sahm이 규칙을 발표한 2019년에
 * 만들어져 개정 이력이 그때부터만 있습니다(vintage 82개). 그래서 그 시리즈에
 * 기대면 되살릴 수 있는 구간이 2019년 이후로 잘리고, **정작 확인하고 싶은
 * 2008년이 통째로 빠집니다.**
 *
 * 규칙 자체는 실업률 하나만 있으면 계산되고, UNRATE는 vintage가 797개로 훨씬
 * 깁니다. 그리고 이쪽이 원래 정의에 더 맞습니다 — `SAHMREALTIME`의 "real-time"이
 * 뜻하는 것이 **개정 전 실업률로 계산한다**는 것이고, vintage로 하는 계산이
 * 정확히 그것입니다.
 *
 * 관측은 날짜 내림차순(월간)이므로 0번이 최신입니다. 3개월 평균 13개가 필요하니
 * 최소 15개 관측이 있어야 한 점이 나옵니다.
 */
export function computeSahm(unemploymentObservations) {
  const observations = unemploymentObservations ?? [];
  const movingAverage3 = [];
  for (let index = 0; index + 2 < observations.length; index += 1) {
    movingAverage3.push(
      (observations[index].value + observations[index + 1].value + observations[index + 2].value) / 3,
    );
  }

  const result = [];
  for (let index = 0; index + 12 < movingAverage3.length; index += 1) {
    const trailingLow = Math.min(...movingAverage3.slice(index + 1, index + 13));
    result.push({
      ...observations[index],
      value: round2(movingAverage3[index] - trailingLow),
    });
  }
  return result;
}

/**
 * 2008-12-16부터 연준이 목표를 "범위"로 바꾸면서 시리즈가 갈렸습니다.
 * 그 전 구간은 단일 목표(`DFEDTAR`)로 채워 이어 붙입니다. 겹치는 날짜가 없으므로
 * 합친 뒤 내림차순으로 다시 정렬하면 하나의 연속된 시계열이 됩니다.
 */
function spliceFedTarget(modern, legacy) {
  const seen = new Set(modern.map((item) => item.date));
  return [...modern, ...legacy.filter((item) => !seen.has(item.date))]
    .sort((a, b) => b.date.localeCompare(a.date));
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

  // 2008년 이전을 되살리려면 두 곳을 메워야 합니다. 둘 다 지표가 그때 없었을
  // 뿐이고, 그 시점에 알 수 있었던 정보만으로 채웁니다.
  const legacy = series.fedLegacy?.observations ?? [];
  if (legacy.length > 0) {
    for (const key of ["fedUpper", "fedLower"]) {
      if (series[key]) {
        series[key] = {
          ...series[key],
          observations: spliceFedTarget(series[key].observations, legacy),
        };
      }
    }
  }

  // Sahm은 항상 직접 계산합니다. 2019년을 경계로 출처가 바뀌면 그 지점에서
  // 값의 성격이 달라져 국면 비교가 오염됩니다.
  if (series.unemployment) {
    series.sahm = {
      ...(series.sahm ?? {}),
      id: "SAHM_COMPUTED",
      name: "Sahm 경기침체 지표(실업률 vintage에서 계산)",
      observations: computeSahm(series.unemployment.observations),
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

/**
 * 직접 계산한 Sahm이 FRED의 `SAHMREALTIME`과 맞는지 대조합니다.
 *
 * 2019년 이후는 두 값이 다 있으므로 겹치는 구간에서 대조할 수 있습니다.
 * **여기서 맞으면 같은 계산을 2008년까지 밀어 넣어도 된다는 근거가 됩니다.**
 * 안 맞으면 계산이 틀린 것이고, 그 상태로 과거를 되살리면 조용히 틀린 결론이
 * 나옵니다 — 대조 없이 넘어가면 안 되는 이유입니다.
 *
 * 두 값 모두 "그날 알 수 있었던 것"으로 맞춰 비교합니다. 최신 개정본끼리
 * 비교하면 SAHMREALTIME은 개정 전 값으로 계산된 것이라 어긋납니다.
 */
export function compareSahmSources(vintages, asOfDates) {
  const fredSeries = vintages.series?.sahm?.observations ?? [];
  const unemployment = vintages.series?.unemployment?.observations ?? [];
  const deviations = [];

  for (const date of asOfDates) {
    const fred = observationsAsOf(fredSeries, date)[0];
    const computed = computeSahm(observationsAsOf(unemployment, date))[0];
    if (!fred || !computed) continue;
    // 같은 관측월끼리만 비교합니다. 발표 시점이 어긋나면 다른 달을 비교하게 됩니다.
    if (fred.date !== computed.date) continue;
    deviations.push({ date, observationDate: fred.date, fred: fred.value, computed: computed.value });
  }

  if (deviations.length === 0) return { count: 0 };
  const gaps = deviations.map((item) => Math.abs(item.fred - item.computed));
  const worst = deviations[gaps.indexOf(Math.max(...gaps))];
  return {
    count: deviations.length,
    maxAbsDiff: round(Math.max(...gaps)),
    meanAbsDiff: round(average(gaps)),
    exactMatches: gaps.filter((gap) => gap < 0.005).length,
    worst,
  };
}

/**
 * 적용률이 낮을 때 **어느 지표가 막고 있는지** 지표별로 찾습니다.
 *
 * 여섯 층 중 하나라도 비면 그날은 통째로 판정 불가라, 전체 적용률만 봐서는
 * 무엇을 고쳐야 하는지 알 수 없습니다. 지표마다 "언제부터 쓸 수 있는가"를
 * 내면 가장 늦게 시작하는 하나가 곧 병목입니다.
 *
 * 날짜가 정렬돼 있으므로 이분탐색으로 찾습니다.
 */
export function diagnoseCoverage(vintages, dates) {
  const keys = [...new Set([...Object.keys(vintages.series ?? {}), "sahm"])];
  const usableAt = (key, index) => {
    const series = macroDataAsOf(vintages, dates[index]).series[key];
    return (series?.observations?.length ?? 0) > 0;
  };

  const report = [];
  for (const key of keys) {
    // fedLegacy는 fedUpper를 메우는 재료일 뿐 직접 쓰이지 않습니다.
    if (key === "fedLegacy") continue;
    if (!usableAt(key, dates.length - 1)) {
      report.push({ key, firstUsable: null, firstIndex: null });
      continue;
    }
    let low = 0;
    let high = dates.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (usableAt(key, middle)) high = middle;
      else low = middle + 1;
    }
    report.push({ key, firstUsable: toDateString(dates[low]), firstIndex: low });
  }
  return report.sort((a, b) => (b.firstIndex ?? Infinity) - (a.firstIndex ?? Infinity));
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

// SAHMREALTIME이 소수점 둘째 자리까지 발표되므로 대조할 수 있게 자릿수를 맞춥니다.
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toDate(value) {
  return value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
}

function toDateString(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
