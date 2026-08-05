import { generateMarket } from "./synthetic-prices.js";

/**
 * 합성 시나리오 모음입니다.
 *
 * 규칙 하나의 성질은 한 경로에서만 보면 우연과 구분되지 않습니다.
 * 상승·하락·모멘텀·평균회귀 네 국면에서 같은 규칙을 돌려, 어느 국면에서
 * 손해가 나는지를 봅니다.
 */
export const SCENARIOS = Object.freeze({
  bull: {
    label: "상승장 (연 +10%, 변동성 15%)",
    options: { annualDrift: 0.10, annualVol: 0.15 },
  },
  bear: {
    label: "하락 후 회복 (중간에 -35% 구간)",
    options: {
      annualDrift: 0.08,
      annualVol: 0.16,
      // 07-29~08-04에 실제로 당한 패턴입니다. 급락 뒤 빠른 회복 구간에서
      // 방어 매도 후 재진입이 느리면 손실이 확정됩니다.
      shocks: [
        { startDay: 400, days: 120, annualDrift: -0.55, annualVol: 0.35 },
        { startDay: 520, days: 160, annualDrift: 0.45, annualVol: 0.22 },
      ],
    },
  },
  choppy: {
    label: "횡보·평균회귀 (추세 필터가 가장 불리한 국면)",
    options: { annualDrift: 0.01, annualVol: 0.20, autocorrelation: -0.12 },
  },
  momentum: {
    label: "추세 지속 (추세 필터가 가장 유리한 국면)",
    options: { annualDrift: 0.07, annualVol: 0.18, autocorrelation: 0.10 },
  },
});

export function buildScenario(name, { seed, days, symbols }) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    throw new Error(`알 수 없는 시나리오: ${name} (가능: ${Object.keys(SCENARIOS).join(", ")})`);
  }
  return generateMarket(seed, symbols, { ...scenario.options, days });
}
