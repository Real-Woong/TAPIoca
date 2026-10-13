import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 원화 매입가 등록부 (2026-10-13).
 *
 * 토스 앱 수익률은 (기준환율 평가금 - 원화 매입금) / 원화 매입금입니다. 원화 매입금에는
 * 매입 당일 환율이 들어 있는데 Open API는 이 환율을 주지 않습니다. 그래서 앱에 보이는
 * «1주 평균금액»(원)을 한 번 등록해 두고 그것으로 원화 손익률을 계산합니다.
 * BAC로 검증: (439,288 - 90,637×6) / (90,637×6) = -19.22% = 앱 값.
 *
 * 파일은 `data/krw-cost-basis.json`입니다. 개인 자산 정보라 gitignore되는 data/에 둡니다.
 *   { "asOf": "2026-10-13", "positions": { "BAC": { "quantity": 6, "avgKrw": 90637 } } }
 *
 * **수량이 등록값보다 늘면 계산하지 않습니다.** 새로 산 몫의 환율을 모르는데 옛 평균으로
 * 덮으면 틀린 수익률이 나옵니다. 줄어든 경우(매도)는 평균 단가가 그대로라 계산합니다.
 */
export const KRW_COST_FILE = "krw-cost-basis.json";

export async function loadKrwCostBasis(dataDir) {
  let text;
  try {
    text = await readFile(path.join(dataDir, KRW_COST_FILE), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.positions !== "object") {
    throw new Error(`${KRW_COST_FILE} 형식이 올바르지 않습니다 (positions 객체가 필요합니다).`);
  }
  return parsed;
}

/**
 * @returns {{status: "ok", costKrw: number, profitKrw: number, rate: number}
 *   | {status: "missing"} | {status: "stale"}}
 */
export function krwReturn({ symbol, quantity, valueKrw }, costBasis) {
  const entry = costBasis?.positions?.[String(symbol ?? "").toUpperCase()];
  const registeredQty = Number(entry?.quantity);
  const avgKrw = Number(entry?.avgKrw);
  if (!entry || !(registeredQty > 0) || !(avgKrw > 0)) return { status: "missing" };

  const qty = Number(quantity);
  const value = Number(valueKrw);
  if (!Number.isFinite(qty) || !Number.isFinite(value)) return { status: "missing" };
  if (qty > registeredQty * (1 + 1e-9) + 1e-9) return { status: "stale" };

  const costKrw = qty * avgKrw;
  if (!(costKrw > 0)) return { status: "missing" };
  const profitKrw = value - costKrw;
  return { status: "ok", costKrw, profitKrw, rate: profitKrw / costKrw };
}
