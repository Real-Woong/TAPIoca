/**
 * 토스 앱이 해외주식 원화 평가에 쓰는 «기준환율»을 가져옵니다 (2026-10-13).
 *
 * 토스 공식 FAQ(#3557·#3551·#3721)는 평가금·총자산에 서울외국환중개의 해당일(또는 최근
 * 영업일) 기준환율을 쓴다고 합니다. 하루 동안 고정이라 Open API의 실시간 `rate`·`midRate`와
 * 다릅니다. 토스 API는 이 값을 주지 않아서 한국은행 ECOS 일별 «원/미국달러(매매기준율)»
 * (731Y001/0000001)를 씁니다 — 같은 날 1,335.8로 앱 평가 환율 역산값과 일치했습니다.
 *
 * `ECOS_API_KEY`가 없으면 한국은행이 주는 `sample` 키로 조회합니다(10건 제한이라 한 건이면
 * 충분). 안정적으로 쓰려면 ecos.bok.or.kr에서 무료 키를 발급해 `.env`에 넣으십시오.
 */

const ECOS_BASE_URL = "https://ecos.bok.or.kr/api/StatisticSearch";
const LOOKBACK_DAYS = 10;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstYyyymmdd(date) {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10).replaceAll("-", "");
}

/** 가장 최근 영업일의 매매기준율을 돌려줍니다. 새벽처럼 오늘 값이 아직 없으면 직전 영업일 값입니다. */
export async function fetchBaseRate({
  apiKey = process.env.ECOS_API_KEY || "sample",
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = 10_000,
} = {}) {
  const end = kstYyyymmdd(now);
  const start = kstYyyymmdd(new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
  const url = `${ECOS_BASE_URL}/${encodeURIComponent(apiKey)}/json/kr/1/10/731Y001/D/${start}/${end}/0000001`;

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`한국은행 ECOS 응답 오류 (HTTP ${response.status})`);
  const body = await response.json();

  const rows = body?.StatisticSearch?.row;
  if (!Array.isArray(rows) || rows.length === 0) {
    const reason = body?.RESULT?.MESSAGE ?? "조회된 기준환율이 없습니다";
    throw new Error(`한국은행 ECOS: ${String(reason).split("\n")[0]}`);
  }

  const latest = [...rows].sort((a, b) => String(a.TIME).localeCompare(String(b.TIME))).at(-1);
  const rate = Number(latest?.DATA_VALUE);
  if (!(Number.isFinite(rate) && rate > 0)) {
    throw new Error(`한국은행 ECOS: 기준환율 값을 읽을 수 없습니다 (${latest?.DATA_VALUE ?? "없음"})`);
  }

  const t = String(latest.TIME);
  return { rate, date: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` };
}
