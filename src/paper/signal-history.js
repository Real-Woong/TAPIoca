import { readPaperEvents } from "./event-log.js";

// 이벤트 로그에 쌓인 원본 신호를 사후 분석용 시계열로 되돌립니다.
//
// 추세·MACD·FRED는 언제든 원본 시계열을 다시 받아 재현할 수 있지만, 뉴스 감성은
// 그날의 GDELT·Bluesky·RSS 수집창이 지나가면 복원할 방법이 없습니다. 그래서
// 감성 층만은 운영 로그가 유일한 데이터 원천이고, 이 모듈이 그 원천을 읽습니다.

const newYorkDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * 감성 스냅샷 단위의 시계열을 만듭니다.
 *
 * PAPER 실행기는 15분마다 돌지만 뉴스는 NEWS_CACHE_MINUTES(기본 60분) 동안
 * 같은 스냅샷을 재사용합니다. 사이클마다 한 줄씩 세면 같은 뉴스가 26번 계산돼
 * 표본 수가 부풀고 자기상관이 1에 가깝게 왜곡됩니다. 그래서 수집 시각(fetchedAt)
 * 하나당 한 건만 남깁니다.
 */
export function extractSentimentSeries(events) {
  const bySnapshot = new Map();
  for (const event of events) {
    const sentiment = event?.signals?.sentiment;
    if (!sentiment || !sentiment.fetchedAt) continue;
    // 같은 스냅샷이 여러 사이클에 걸쳐 있으면 가장 이른 관측만 남깁니다.
    if (bySnapshot.has(sentiment.fetchedAt)) continue;
    bySnapshot.set(sentiment.fetchedAt, {
      fetchedAt: sentiment.fetchedAt,
      tradingDate: newYorkDate.format(new Date(event.at)),
      score: sentiment.score,
      confidence: sentiment.confidence,
      articleCount: sentiment.articleCount,
      sourceCounts: sentiment.sourceCounts ?? null,
      // 살아 있던 소스를 이름순으로 이어 붙인 지문입니다. 이 값이 바뀌는
      // 지점이 곧 표본을 갈라야 하는 지점입니다.
      sourceFingerprint: fingerprintSources(sentiment.sourceHealth),
      ageHours: event.signals.sentimentFreshness?.ageHours ?? null,
      multiplier: event.signals.sentimentFreshness?.multiplier ?? null,
      contribution: event.contributions?.sentiment ?? null,
      weight: event.signals.weights?.sentiment ?? null,
      fredScore: event.signals.fred?.score ?? null,
      trendScore: event.signals.trend?.score ?? null,
      macdScore: event.signals.macd?.score ?? null,
      combinedScore: event.score ?? null,
    });
  }
  return [...bySnapshot.values()].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
}

/**
 * 살아 있던 소스만 모아 지문을 만듭니다.
 *
 * 소스 구성이 바뀌면 그 전후는 **다른 것을 잰 표본**입니다. 지문이 같은 구간만
 * 묶어야 자기상관이 의미를 가집니다.
 */
function fingerprintSources(sourceHealth) {
  if (!Array.isArray(sourceHealth) || sourceHealth.length === 0) return null;
  return [...new Set(sourceHealth.filter((item) => item.ok).map((item) => item.source))]
    .sort()
    .join("+");
}

/**
 * 지문이 없는 스냅샷에 붙이는 이름입니다.
 *
 * `sourceHealth`는 2026-08-08부터 기록합니다. 그 전 스냅샷에는 지문이 없는데,
 * 예전에는 그것을 `filter(Boolean)`으로 조용히 버리고 남은 지문 하나만 셌습니다.
 * 그래서 08-06의 옛 구성(기사 359건·신뢰도 0.60)과 08-07 이후의 새 구성(462건·
 * 0.77)이 한 표본에 섞여 있는데도 "구성이 그대로"라고 답했습니다.
 *
 * **모른다는 것은 같다는 것이 아닙니다.** 관문이 막으려던 바로 그 경우에 통과를
 * 내주던 구멍이라, 지문 없음을 별개의 구성으로 셉니다.
 */
export const UNKNOWN_FINGERPRINT = "(지문없음)";

function fingerprintOf(row) {
  return row.sourceFingerprint || UNKNOWN_FINGERPRINT;
}

/**
 * 지문이 바뀌는 지점에서 시계열을 자릅니다.
 *
 * 판정은 **마지막 구간**으로만 합니다. 구성이 다른 구간을 이어 붙여 자기상관을
 * 재면 소스가 바뀐 자국을 지속성으로 읽습니다.
 */
export function splitBySourceFingerprint(series) {
  const segments = [];
  for (const row of series) {
    const fingerprint = fingerprintOf(row);
    const last = segments[segments.length - 1];
    if (last && last.fingerprint === fingerprint) last.rows.push(row);
    else segments.push({ fingerprint, rows: [row] });
  }
  return segments;
}

/** 하루에 여러 스냅샷이 있으면 마지막 것만 남겨 일봉 백테스트에 맞춥니다. */
export function toDailySeries(series) {
  const byDate = new Map();
  for (const row of series) byDate.set(row.tradingDate, row);
  return [...byDate.values()].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
}

/**
 * 감성 층이 신호인지 잡음인지 판별하는 통계를 냅니다.
 *
 * 판정 기준은 1차 자기상관입니다. 시장에 대한 실제 정보를 담은 신호는 하루 만에
 * 통째로 뒤집히지 않으므로 양의 자기상관이 나옵니다. 반대로 0 근처거나 음수면
 * 매일 새로 뽑는 난수와 구분되지 않는다는 뜻이고, 그런 값에 가중치를 주는 것은
 * 배분을 흔들어 거래비용만 쓰는 일입니다.
 */
/**
 * 값이 사실상 멈췄다고 볼 문턱입니다.
 *
 * 감성 원점수는 −1~+1 범위이므로 0.01은 전체 폭의 0.5%입니다. 그보다 덜
 * 움직이면 "안정적"이 아니라 **고장**으로 봅니다.
 *
 * **이 관문이 자기상관보다 앞서야 합니다.** 멈춘 값은 자기상관이 1에 가까운데,
 * 사전 규칙은 0.3 이상을 "값이 이어짐 → 가중치 유지"로 읽습니다. 그대로 두면
 * **고장을 신호로 읽고 정반대 결론**을 냅니다. 거시 층에서 "구간이 대부분 정확히
 * 0이면 규칙이 발동하지 않은 것"이라고 한 것과 같은 함정입니다.
 */
export const STUCK_STDEV_THRESHOLD = 0.01;

export function summarizeSentimentSeries(series) {
  const scores = series.map((row) => Number(row.score)).filter(Number.isFinite);
  if (scores.length === 0) {
    return { count: 0, mean: null, stdev: null, meanAbsChange: null, autocorrelation: null };
  }
  const mean = average(scores);
  const stdev = Math.sqrt(average(scores.map((score) => (score - mean) ** 2)));
  const changes = scores.slice(1).map((score, index) => Math.abs(score - scores[index]));

  const distinctValues = new Set(scores.map((score) => Math.round(score * 1000))).size;
  // 표본 안에서 소스 구성이 바뀌었는지 봅니다. 바뀌었다면 그 표본은 두 가지를
  // 섞어 잰 것이라 자기상관을 그대로 쓸 수 없습니다.
  // 지문이 없는 구간도 하나의 구성으로 셉니다. 버리면 "구성이 그대로"로 읽힙니다.
  const fingerprints = [...new Set(series.map(fingerprintOf))];

  return {
    sourceFingerprints: fingerprints,
    mixedSources: fingerprints.length > 1,
    count: scores.length,
    firstDate: series[0].tradingDate,
    // **값이 움직이는가.** 자기상관보다 먼저 보는 관문입니다.
    distinctValues,
    stuck: stdev < STUCK_STDEV_THRESHOLD,
    lastDate: series[series.length - 1].tradingDate,
    tradingDays: new Set(series.map((row) => row.tradingDate)).size,
    mean: round(mean),
    stdev: round(stdev),
    min: round(Math.min(...scores)),
    max: round(Math.max(...scores)),
    // 하루 평균 변동폭. 표준편차와 비슷하면 값이 매일 처음부터 다시 뽑히는 것입니다.
    meanAbsChange: changes.length ? round(average(changes)) : null,
    signFlips: scores.slice(1).filter((score, index) => score * scores[index] < 0).length,
    autocorrelation: autocorrelation(scores, mean, stdev),
  };
}

function autocorrelation(scores, mean, stdev) {
  // 표본이 너무 적으면 숫자가 나오더라도 의미가 없으므로 아예 내지 않습니다.
  if (scores.length < 10 || stdev === 0) return null;
  const covariance = average(
    scores.slice(1).map((score, index) => (score - mean) * (scores[index] - mean)),
  );
  return round(covariance / stdev ** 2);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

export async function loadSignalHistory(dataDir) {
  const events = await readPaperEvents(dataDir);
  const series = extractSentimentSeries(events);
  const daily = toDailySeries(series);
  // **판정 표본은 마지막 소스 구성의 구간뿐입니다.** 구성이 바뀐 지점 앞은 다른
  // 것을 잰 표본이라, 이어 붙이면 10거래일을 채운 것처럼 보이지만 실제로는
  // 두 가지를 섞어 잰 것입니다.
  const dailySegments = splitBySourceFingerprint(daily);
  const judgingDaily = dailySegments.length ? dailySegments[dailySegments.length - 1].rows : daily;
  const snapshotSegments = splitBySourceFingerprint(series);
  const judgingSnapshots = snapshotSegments.length
    ? snapshotSegments[snapshotSegments.length - 1].rows
    : series;
  return {
    eventCount: events.length,
    // 원본 신호가 없는 예전 이벤트가 몇 건인지 함께 알려, 표본이 언제부터 쌓였는지 드러냅니다.
    withSignals: events.filter((event) => event.signals).length,
    series,
    daily,
    // **판정은 일별로 한다.** 이유는 아래 두 가지입니다.
    //
    // 1. 스냅샷 단위는 뉴스 캐시(기본 60분) 때문에 1시간 간격입니다. 같은 뉴스
    //    사이클 안이라 자기상관이 부풀려지고, "1시간 뒤에도 값이 비슷하다"로
    //    0.3을 넘겨 정보를 담았다고 판정할 수 있습니다.
    // 2. 스냅샷 시계열은 간격이 고르지 않습니다. 장 마감 마지막 스냅샷과 다음 날
    //    첫 스냅샷 사이는 17.5시간인데 같은 1차 시차로 취급됩니다.
    //
    // 그리고 실제로 문제가 된 것이 일간이었습니다 — 08-05 +0.108에서 08-06
    // −0.545로 하루 만에 부호가 뒤집혀 IWM 편입이 촉발됐습니다. 매매 판단이
    // 일어나는 시간축도 그쪽입니다.
    //
    // 08-06에 정한 판정 규칙은 문턱(0.1/0.3)과 표본 수(10)만 박았고 간격은
    // 비어 있었습니다. **그 빈칸을 결과가 나오기 전에 채운 것이지 규칙을 바꾼
    // 것이 아닙니다.** 문턱과 표본 수는 그대로입니다.
    summary: summarizeSentimentSeries(judgingDaily),
    // 구성이 바뀐 지점을 보여 주기 위한 것입니다. 어느 구간을 뺐는지 말없이
    // 빼면, 이번에 고친 구멍과 반대 방향으로 같은 잘못을 합니다.
    dailySegments,
    judgingSnapshotCount: judgingSnapshots.length,
    // 이 시각부터가 판정 표본입니다. 구간은 시간순으로 이어져 있으므로 이 앞은
    // 전부 옛 구성입니다.
    judgingFrom: judgingSnapshots[0]?.fetchedAt ?? null,
    // 표본 전체입니다. 참고로만 냅니다 — 구성이 섞여 있으면 판정에 쓸 수 없습니다.
    fullSummary: summarizeSentimentSeries(daily),
    // 참고용입니다. 판정에 쓰지 않습니다.
    snapshotSummary: summarizeSentimentSeries(judgingSnapshots),
  };
}
