import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 실계좌의 **원가와 환율을 하루 한 줄씩** 남기는 원장입니다 (2026-09-18).
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────────────────
 *
 * 토스는 `/api/v1/holdings`에서 `averagePurchasePrice`와 `profitLoss`를 줍니다.
 * **미실현손익은 브로커한테 받으면 되고 우리가 계산할 필요가 없습니다.** 그러나
 * **실현손익은 어느 엔드포인트에도 없습니다**(2026-09-18에 가이드 전체를 훑었고,
 * `/api/v1/trades`는 계좌 체결이 아니라 시세입니다).
 *
 * 그렇다고 우리가 계산하면 토스와 조금씩 어긋납니다. 9/17 SCHD 매도에서
 * 우리 평균원가는 **$33.6024**였는데 토스가 실제로 쓴 원가는 **$33.5552**였습니다
 * (총매수 $15.9858 − 토스가 말한 남은 원가 $13.5262). **토스의 lot 방식을
 * 우리가 모릅니다.**
 *
 * 몰라도 되는 방법이 있습니다. **`purchaseAmount`가 줄어든 만큼이 곧 판 원가입니다.**
 * 토스 숫자만 쓰므로 lot 방식과 무관하고, 같은 줄에 그날 환율을 적어 두면
 * 원화 원가가 함께 쌓입니다 — 그러면 매도가 났을 때 **토스 앱의 「최종 수익」과
 * 같은 분해**(주가 몫 / 환차)를 보고서가 그대로 낼 수 있습니다.
 *
 * ── 그래서 계산보다 기록이 급했다 ───────────────────────────────────────────
 *
 * **계산은 아무 때나 짤 수 있지만 스냅샷은 지나가면 못 만듭니다.** ㉙에서 호가에
 * 대해 배운 것과 같습니다. 9/17 매도를 소급하지 못하는 것도 같은 이유입니다 —
 * 그날의 `purchaseAmount`가 없습니다.
 *
 * ── 고치지 않는다 ───────────────────────────────────────────────────────────
 *
 * `live-orders.jsonl`과 같은 규칙입니다. 덧붙이기만 하고 지난 줄은 건드리지
 * 않습니다. 하루 한 줄이라 거래일 기준으로 중복을 막습니다.
 */

const COST_BASIS_FILE = "live-cost-basis.jsonl";

export function costBasisLogPath(dataDir) {
  return path.join(dataDir, COST_BASIS_FILE);
}

export async function appendCostBasisSnapshot(dataDir, snapshot) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(costBasisLogPath(dataDir), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}

export async function readCostBasisSnapshots(dataDir) {
  let text;
  try {
    text = await readFile(costBasisLogPath(dataDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function hasSnapshotFor(snapshots, tradingDate) {
  return (snapshots ?? []).some((snapshot) => snapshot?.tradingDate === tradingDate);
}

/**
 * 토스 응답을 숫자로 폅니다. **문자열로 옵니다** — `"0.402434"`처럼.
 *
 * 없는 값은 `null`로 둡니다. 0으로 바꾸면 "수수료가 0이다"와 "수수료를 모른다"가
 * 한 칸에 섞입니다. 실제로 `cost.tax`가 `null`로 옵니다.
 */
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeHolding(item) {
  return {
    symbol: item?.symbol ?? null,
    quantity: num(item?.quantity),
    lastPriceUsd: num(item?.lastPrice),
    averagePriceUsd: num(item?.averagePurchasePrice),
    purchaseAmountUsd: num(item?.marketValue?.purchaseAmount),
    marketValueUsd: num(item?.marketValue?.amount),
    marketValueAfterCostUsd: num(item?.marketValue?.amountAfterCost),
    unrealizedUsd: num(item?.profitLoss?.amount),
    unrealizedAfterCostUsd: num(item?.profitLoss?.amountAfterCost),
    unrealizedRate: num(item?.profitLoss?.rate),
    // **이 둘이 무엇인지 아직 모릅니다.** `amountAfterCost`가 평가액에서 이만큼을
    // 뺀 값이라 "지금 팔면 들 비용"으로 읽히는데, 확인한 적이 없습니다.
    // 원본을 남겨 두면 나중에 알아낸 뒤 과거 줄을 다시 읽을 수 있습니다.
    commissionUsd: num(item?.cost?.commission),
    taxUsd: num(item?.cost?.tax),
  };
}

/** 관리 종목만 남깁니다. 나머지는 사장님 자산이고 이 시스템이 볼 것이 아닙니다. */
export function normalizeHoldings(items, managedSymbols) {
  const managed = new Set((managedSymbols ?? []).map((symbol) => String(symbol).toUpperCase()));
  return (items ?? [])
    .filter((item) => item?.symbol && managed.has(String(item.symbol).toUpperCase()))
    .map(normalizeHolding)
    .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
}

/** 관리 종목 합계입니다. 계좌 전체(`totalPurchaseAmount`)가 아닙니다. */
export function summarizeHoldings(holdings) {
  const rows = (holdings ?? []).filter((row) => row.purchaseAmountUsd !== null);
  if (rows.length === 0) return null;

  const purchaseUsd = rows.reduce((sum, row) => sum + row.purchaseAmountUsd, 0);
  const marketUsd = rows.reduce((sum, row) => sum + (row.marketValueUsd ?? 0), 0);
  return {
    purchaseUsd,
    marketUsd,
    unrealizedUsd: marketUsd - purchaseUsd,
    unrealizedRate: purchaseUsd > 0 ? (marketUsd - purchaseUsd) / purchaseUsd : null,
    symbols: rows.length,
  };
}

export function buildCostBasisSnapshot({ tradingDate, holdings, krwPerUsd = null, at }) {
  return {
    type: "SNAPSHOT",
    tradingDate,
    at: at ?? new Date().toISOString(),
    // **환율이 없으면 null로 남깁니다.** 그날 원화 원가를 못 쌓을 뿐, 달러
    // 원가는 그대로 쓸 수 있습니다. 없는 값을 지어내면 나중에 구분이 안 됩니다.
    krwPerUsd,
    holdings,
  };
}
