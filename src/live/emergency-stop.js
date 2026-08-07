import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 긴급 중지 스위치입니다.
 *
 * **환경변수가 아니라 파일인 이유가 있습니다.** 환경변수를 바꾸려면 서비스를
 * 다시 띄워야 하는데, 멈추고 싶은 순간은 대개 뭔가 잘못 돌고 있는 순간입니다.
 * 그때 재시작을 요구하면 스위치가 늦게 듣습니다. 파일은 `touch` 한 번이면
 * 다음 사이클부터 즉시 듣습니다.
 *
 * **판독은 fail-closed입니다.** 파일을 읽다가 알 수 없는 오류가 나면 "중지
 * 아님"이 아니라 **"중지"로 봅니다.** 안전 스위치는 고장 났을 때 안전한 쪽으로
 * 넘어져야 합니다. 디스크가 이상한 상태에서 매매를 계속하는 것보다 멈추는 편이
 * 언제나 낫습니다.
 */

const STOP_FILE = "EMERGENCY_STOP";

export function emergencyStopPath(dataDir) {
  return path.join(dataDir, STOP_FILE);
}

/**
 * 지금 멈춰 있는지 봅니다.
 * @returns {Promise<{stopped: boolean, reason: string|null, since: string|null}>}
 */
export async function readEmergencyStop(dataDir) {
  let text;
  try {
    text = await readFile(emergencyStopPath(dataDir), "utf8");
  } catch (error) {
    // 파일이 없다 = 멈춤이 아니다. 이것만이 "돌아도 된다"는 확실한 사실입니다.
    if (error.code === "ENOENT") return { stopped: false, reason: null, since: null };
    // 권한 오류·I/O 오류 등은 판단할 수 없으므로 멈춤으로 봅니다.
    return {
      stopped: true,
      reason: `긴급 중지 파일을 읽을 수 없습니다(${error.code}). 안전을 위해 멈춤으로 봅니다.`,
      since: null,
    };
  }

  // 내용은 참고용입니다. **파일이 있다는 사실만으로 멈춥니다** — 내용이 깨져도
  // 스위치는 들어야 합니다.
  try {
    const parsed = JSON.parse(text);
    return { stopped: true, reason: parsed.reason ?? null, since: parsed.at ?? null };
  } catch {
    return { stopped: true, reason: text.trim().slice(0, 200) || null, since: null };
  }
}

/**
 * 멈춥니다. 그리고 **이미 낸 주문을 거둡니다.**
 *
 * 취소까지 해야 스위치가 실효를 가집니다. 신규 주문만 막으면 이미 시장에 나가
 * 있는 주문은 그대로 체결되고, 정작 멈추고 싶었던 것이 그것일 수 있습니다.
 *
 * 취소가 일부 실패해도 **플래그는 반드시 남깁니다.** 순서가 중요합니다 —
 * 플래그를 먼저 쓰고 취소를 시도해야, 취소 도중에 죽어도 다음 사이클이 멈춥니다.
 */
export async function engageEmergencyStop(dataDir, {
  reason = "수동 중지",
  broker = null,
  at = new Date().toISOString(),
} = {}) {
  // 디렉터리가 없으면 플래그를 못 씁니다. 갓 배포한 호스트에서 `data/`가 아직
  // 없을 수 있는데, **긴급 중지가 정작 필요한 순간에 실패하는 종류의 실패**라
  // 여기서 먼저 만듭니다.
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    emergencyStopPath(dataDir),
    `${JSON.stringify({ at, reason }, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (!broker) return { stopped: true, canceled: [], failed: [] };

  const canceled = [];
  const failed = [];
  let openOrders = [];
  try {
    openOrders = await broker.listOpenOrders();
  } catch (error) {
    failed.push({ clientOrderId: null, message: `미체결 목록 조회 실패: ${error.message}` });
  }

  for (const order of openOrders) {
    try {
      const result = await broker.cancelOrder(order.clientOrderId);
      (result?.canceled ? canceled : failed).push({
        clientOrderId: order.clientOrderId,
        message: result?.canceled ? null : "취소되지 않음(이미 체결됐을 수 있음)",
      });
    } catch (error) {
      failed.push({ clientOrderId: order.clientOrderId, message: error.message });
    }
  }

  return { stopped: true, canceled, failed };
}

/**
 * 중지를 풉니다. **사람이 명시적으로 해야 합니다** — 코드가 스스로 풀면
 * 스위치가 아니라 지연 장치입니다.
 */
export async function releaseEmergencyStop(dataDir) {
  try {
    await unlink(emergencyStopPath(dataDir));
    return { released: true };
  } catch (error) {
    if (error.code === "ENOENT") return { released: false, reason: "이미 풀려 있습니다." };
    throw error;
  }
}
