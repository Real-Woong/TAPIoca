import { readEmergencyStop } from "./emergency-stop.js";
import { HALT_REASONS, planCycle } from "./execution-plan.js";
import { buildOrders, reconcile, unresolvedOrders } from "./order-lifecycle.js";
import { OUTCOMES, classifyOutcome, resolveOrders } from "./order-outcome.js";
import { appendOrderEvent, clientOrderId, readOrderEvents } from "./order-store.js";

/**
 * 실거래 한 사이클입니다. PAPER 엔진이 낸 **의도**를 받아 실제 주문으로 옮깁니다.
 *
 * PAPER와 나란히 돌리는 것이 목적입니다. 같은 신호로 두 장부를 돌려 그 차이를
 * 보면 **체결 비용의 실측값**이 나옵니다. 백테스트가 전 구간 10bp를 가정했는데
 * 그 가정이 맞는지는 이 방법으로만 확인할 수 있습니다.
 *
 * ── 순서가 곧 안전장치입니다 ──────────────────────────────────────────────
 *
 *   1. 지난 주문의 결말을 짓는다   (조회만. 재제출하지 않는다)
 *   2. 멈출 이유를 본다             (긴급중지·미결·대사·시간창)
 *   3. 남으면 하나를 낸다           (기록 먼저, 그 다음 제출)
 *
 * **1을 2보다 먼저 하는 이유**는, 조회로 결말이 나면 그 사이클에 매매할 수 있기
 * 때문입니다. 순서가 반대면 미결 주문 때문에 멈춘 뒤 조회를 못 해 영영 멈춥니다.
 */

export async function runLiveCycle({
  dataDir,
  broker,
  // PAPER 엔진이 낸 의도입니다: [{ symbol, side, amountUsd }]
  decisions = [],
  // 우리 장부가 생각하는 종목별 평가액입니다. 대사의 한쪽입니다.
  ledgerPositions = {},
  session = { isOpen: true, isAmountOrderWindow: true },
  now = new Date(),
  maxInFlight,
}) {
  const at = now.toISOString();
  const log = [];

  // ── 1. 지난 주문의 결말 ────────────────────────────────────────────────
  let orders = buildOrders(await readOrderEvents(dataDir));
  const pending = unresolvedOrders(orders);

  if (pending.length > 0) {
    const { events, stillUnresolved } = await resolveOrders(broker, pending, { at });
    for (const event of events) await appendOrderEvent(dataDir, event);
    orders = buildOrders(await readOrderEvents(dataDir));

    log.push(
      `미결 ${pending.length}건 조회: ${events.length}건 결말, ${stillUnresolved.length}건 미해결`,
    );
    // 미해결이 남으면 아래 planCycle이 멈춥니다. 여기서 따로 던지지 않는 것은
    // 멈추는 판단을 한 곳(planCycle)에서만 내리기 위해서입니다.
  }

  // ── 2. 멈출 이유 ──────────────────────────────────────────────────────
  const stop = await readEmergencyStop(dataDir);

  // 브로커 보유를 못 읽으면 대사를 할 수 없습니다. **못 한 대사를 통과로 보면
  // 안 됩니다** — 어긋난 채로 매매하지 않는 것이 이 단계의 목적입니다.
  let reconciliation;
  try {
    reconciliation = reconcile(ledgerPositions, await broker.getPositions());
  } catch (error) {
    reconciliation = {
      matched: false,
      differences: [{ symbol: "(조회 실패)", ledgerUsd: null, brokerUsd: null, gapUsd: null }],
      error: error.message,
    };
    log.push(`보유 조회 실패: ${error.message}`);
  }

  const plan = planCycle({
    decisions,
    orders,
    reconciliation,
    emergencyStop: stop.stopped,
    marketOpen: session.isOpen !== false,
    amountOrderWindowOpen: session.isAmountOrderWindow !== false,
    ...(maxInFlight === undefined ? {} : { maxInFlight }),
  });

  if (plan.halted) {
    return { submitted: [], halted: true, reason: plan.reason, message: plan.message, orders, log };
  }

  // ── 3. 주문 ───────────────────────────────────────────────────────────
  const submitted = [];
  for (const decision of plan.submit) {
    const id = clientOrderId({ cycleAt: at, symbol: decision.symbol, side: decision.side });

    // **기록이 제출보다 먼저입니다.** 이 순서가 뒤집히면, 기록과 제출 사이에서
    // 죽었을 때 냈는지 안 냈는지 알 방법이 없습니다.
    await appendOrderEvent(dataDir, {
      type: "PLANNED", clientOrderId: id, at,
      symbol: decision.symbol, side: decision.side, requestedUsd: decision.amountUsd,
    });

    let response = null;
    let error = null;
    try {
      response = await broker.submitOrder({
        clientOrderId: id,
        symbol: decision.symbol,
        side: decision.side,
        amountUsd: decision.amountUsd,
      });
    } catch (caught) {
      error = caught;
    }

    const outcome = classifyOutcome({ response, error });
    if (outcome.outcome === OUTCOMES.ACCEPTED) {
      await appendOrderEvent(dataDir, {
        type: "SUBMITTED", clientOrderId: id, at, brokerOrderId: response.brokerOrderId,
      });
      submitted.push({ clientOrderId: id, brokerOrderId: response.brokerOrderId, ...decision });
    } else if (outcome.outcome === OUTCOMES.REJECTED) {
      await appendOrderEvent(dataDir, {
        type: "REJECTED", clientOrderId: id, at, reason: outcome.why, code: outcome.code,
      });
      log.push(`거절: ${decision.symbol} ${decision.side} — ${outcome.why}`);
    } else {
      // 냈는지 모릅니다. **재제출하지 않고 미결로 둡니다.** 다음 사이클의 1단계가
      // 조회로 결말을 짓고, 그때까지 매매는 멈춥니다.
      log.push(`결말 미정: ${decision.symbol} ${decision.side} — ${outcome.why}`);
    }

    // 한 건이라도 결말이 안 났으면 그 뒤는 내지 않습니다. 계획이 이미 직렬화돼
    // 있지만, maxInFlight를 올린 설정에서도 이 성질이 유지돼야 합니다.
    if (outcome.outcome !== OUTCOMES.ACCEPTED && outcome.outcome !== OUTCOMES.REJECTED) break;
  }

  for (const skipped of plan.skipped) {
    log.push(`다음 사이클로 미룸: ${skipped.symbol} ${skipped.side} $${skipped.amountUsd}`);
  }

  return {
    submitted,
    halted: false,
    reason: null,
    orders: buildOrders(await readOrderEvents(dataDir)),
    log,
  };
}

export { HALT_REASONS };
