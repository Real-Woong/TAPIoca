// FRED(Federal Reserve Economic Data)의 시계열 조회 API 주소입니다.
// series_id를 쿼리 파라미터로 전달하면 해당 경제지표의 관측값을 받을 수 있습니다.
const FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations";

// 조회할 경제지표를 한곳에서 관리합니다.
// Object.freeze()는 실행 중 실수로 설정을 변경하지 못하게 합니다.
export const FRED_SERIES = Object.freeze({
  // 연준이 정한 기준금리 범위의 하단입니다.
  fedLower: {
    id: "DFEDTARL",
    name: "연준 기준금리 하단",
    units: "lin",
  },

  // 연준이 정한 기준금리 범위의 상단입니다.
  fedUpper: {
    id: "DFEDTARU",
    name: "연준 기준금리 상단",
    units: "lin",
  },

  // 식품과 에너지를 제외한 개인소비지출 물가지수입니다.
  corePce: {
    id: "PCEPILFE",
    name: "근원 PCE 전년 대비",
    // pc1은 원본 지수를 전년 동월 대비 변화율(%)로 변환합니다.
    units: "pc1",
  },

  // 미국의 공식 실업률입니다.
  unemployment: {
    id: "UNRATE",
    name: "실업률",
    units: "lin",
  },

  // 실업률 변화를 이용해 경기침체 시작 신호를 계산한 지표입니다.
  sahm: {
    id: "SAHMREALTIME",
    name: "Sahm 경기침체 지표",
    units: "lin",
  },

  // 미국 국채 10년물 금리에서 2년물 금리를 뺀 값입니다.
  yieldCurve: {
    id: "T10Y2Y",
    name: "미국 10년-2년 금리차",
    units: "lin",
  },
});

/**
 * 위에 등록한 모든 경제지표를 병렬로 조회합니다.
 *
 * @param {string} apiKey FRED에서 발급받은 API 키
 * @param {Function} fetchImpl HTTP 요청 함수. 테스트에서는 가짜 fetch를 넣을 수 있습니다.
 * @returns {Promise<object>} 지표 설정과 관측값을 이름별로 묶은 객체
 */
export async function fetchMacroData(apiKey, fetchImpl = fetch) {
  // API 키가 없으면 쓸모없는 네트워크 요청을 보내기 전에 중단합니다.
  if (!apiKey) {
    throw new Error("FRED_API_KEY가 필요합니다.");
  }

  // Object.entries()는 설정 객체를 [key, config] 배열로 바꿉니다.
  // Promise.all()을 사용해 여섯 지표를 하나씩 기다리지 않고 동시에 요청합니다.
  const entries = await Promise.all(
    Object.entries(FRED_SERIES).map(async ([key, config]) => {
      const observations = await fetchFredSeries({
        apiKey,
        seriesId: config.id,
        units: config.units,
        fetchImpl,
      });

      // Object.fromEntries()가 다시 객체로 만들 수 있도록 [키, 값]으로 반환합니다.
      return [key, { ...config, observations }];
    }),
  );

  return {
    // 나중에 데이터가 언제 수집됐는지 확인할 수 있도록 기록합니다.
    fetchedAt: new Date().toISOString(),
    // [key, value] 배열을 { key: value } 객체로 변환합니다.
    series: Object.fromEntries(entries),
  };
}

/**
 * FRED 경제지표 하나의 시계열을 조회합니다.
 *
 * @param {string} apiKey FRED API 키
 * @param {string} seriesId 조회할 FRED 지표 ID
 * @param {string} units lin은 원본값, pc1은 전년 대비 변화율
 * @param {number} limit 가져올 관측값의 최대 개수
 * @param {Function} fetchImpl HTTP 요청 함수
 */
export async function fetchFredSeries({
  apiKey,
  seriesId,
  units = "lin",
  limit = 180,
  fetchImpl = fetch,
  // 개정 이력(vintage)을 받을 때 씁니다. 기본은 지정하지 않음 = 최신 개정본만
  // 받는 지금까지의 동작입니다.
  //
  // **거시 지표를 과거로 되돌려 백테스트하려면 이 값이 반드시 필요합니다.**
  // FRED가 기본으로 주는 것은 **개정된** 값이라, 2008년 실업률을 지금 조회하면
  // 그때는 아무도 몰랐던 확정치가 옵니다. 그대로 쓰면 look-ahead입니다.
  // realtime 범위를 넓게 주면 관측마다 `realtimeStart`가 함께 오고, 그것이
  // "이 값이 세상에 알려진 날"입니다. 그 날짜로 걸러야 그 시점의 판단이 됩니다.
  realtimeStart,
  realtimeEnd,
}) {
  if (!apiKey) throw new Error("FRED_API_KEY가 필요합니다.");
  if (!seriesId) throw new Error("FRED seriesId가 필요합니다.");

  // 문자열을 직접 이어 붙이지 않고 URL 객체를 사용하면 쿼리 값이 안전하게 인코딩됩니다.
  const url = new URL(FRED_API_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("file_type", "json");
  // 최신값을 observations[0]으로 읽을 수 있도록 내림차순으로 받습니다.
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("units", units);
  if (realtimeStart) url.searchParams.set("realtime_start", realtimeStart);
  if (realtimeEnd) url.searchParams.set("realtime_end", realtimeEnd);

  const response = await fetchImpl(url, {
    headers: {
      // JSON 형식의 응답을 원한다는 뜻입니다.
      accept: "application/json",
      // FRED 로그에서 어떤 프로그램의 요청인지 식별할 수 있게 합니다.
      "user-agent": "toss-ai-invest-agent/0.1",
    },
    // 외부 API가 멈췄을 때 프로세스가 무한히 기다리지 않도록 15초 후 취소합니다.
    signal: AbortSignal.timeout(15_000),
  });

  // 200번대 응답이 아니면 HTTP 상태와 **FRED가 적어 보낸 이유**를 함께 냅니다.
  // 상태 코드만 남기면 400의 원인을 추측하게 되는데, FRED는 무엇이 잘못됐는지
  // error_message에 정확히 적어 줍니다. 버리면 안 되는 정보입니다.
  if (!response.ok) {
    const reason = await readFredError(response);
    throw new Error(
      `FRED ${seriesId} 조회 실패: HTTP ${response.status}${reason ? ` — ${reason}` : ""}`,
    );
  }

  // JSON 문자열을 JavaScript 객체로 변환합니다.
  const body = await response.json();

  // 예상과 다른 응답을 뒤의 map()에서 처리하지 않도록 먼저 검사합니다.
  if (!Array.isArray(body.observations)) {
    throw new Error(`FRED ${seriesId} 응답에 observations가 없습니다.`);
  }

  return body.observations
    // FRED는 휴일이나 미발표 값을 "."으로 표시하므로 제거합니다.
    .filter((item) => item.value !== ".")
    // API의 숫자는 문자열이므로 계산할 수 있는 number로 바꿉니다.
    .map((item) => ({
      date: item.date,
      value: Number(item.value),
      // realtime 범위를 요청했을 때만 붙습니다. 지금까지의 호출은 이 필드가 없고
      // 소비자도 안 읽으므로 동작이 바뀌지 않습니다.
      ...(item.realtime_start ? { realtimeStart: item.realtime_start } : {}),
      ...(item.realtime_end ? { realtimeEnd: item.realtime_end } : {}),
    }))
    // 날짜가 없거나 숫자 변환에 실패한 관측값을 마지막으로 제거합니다.
    .filter((item) => item.date && Number.isFinite(item.value));
}

/**
 * 시리즈의 개정 공개일(vintage date) 목록을 받습니다.
 *
 * 한 요청에 담을 수 있는 vintage 날짜가 2000개까지라, 그보다 많은 시리즈는
 * 나눠 요청해야 합니다. 어디서 잘라야 하는지 알려면 목록이 먼저 필요합니다.
 * (2026-08-07 실측: T10Y2Y 3094개, DFEDTARU 3740개, DFEDTARL 5067개)
 */
export async function fetchFredVintageDates({ apiKey, seriesId, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("FRED_API_KEY가 필요합니다.");
  if (!seriesId) throw new Error("FRED seriesId가 필요합니다.");

  const url = new URL("https://api.stlouisfed.org/fred/series/vintagedates");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("limit", "10000");

  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "toss-ai-invest-agent/0.1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const reason = await readFredError(response);
    throw new Error(
      `FRED ${seriesId} 개정일 조회 실패: HTTP ${response.status}${reason ? ` — ${reason}` : ""}`,
    );
  }
  const body = await response.json();
  if (!Array.isArray(body.vintage_dates)) {
    throw new Error(`FRED ${seriesId} 응답에 vintage_dates가 없습니다.`);
  }
  return body.vintage_dates;
}

/** 오류 응답에서 FRED가 적어 보낸 이유를 꺼냅니다. 못 읽으면 조용히 빈 값입니다. */
async function readFredError(response) {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error_message) return String(parsed.error_message);
    } catch {
      // JSON이 아니면 본문 앞부분이라도 남깁니다.
    }
    return text.trim().slice(0, 300);
  } catch {
    return "";
  }
}


// fetchMacroData(apiKey)
//         ↓
// FRED_SERIES의 지표 설정 순회
//         ↓
// fetchFredSeries()를 지표별로 호출
//         ↓
// FRED API에 HTTP 요청
//         ↓
// 응답 상태와 observations 검사
//         ↓
// "." 결측값 제거
//         ↓
// 문자열 value를 숫자로 변환
//         ↓
// 지표별 시계열 객체 반환