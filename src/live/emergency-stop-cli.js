#!/usr/bin/env node

import path from "node:path";

import {
  emergencyStopPath,
  engageEmergencyStop,
  readEmergencyStop,
  releaseEmergencyStop,
} from "./emergency-stop.js";

/**
 * 긴급 중지 스위치를 사람이 조작하는 입구입니다.
 *
 *   npm run stop            멈춘다 (미체결 주문 취소는 아직 하지 않음 — 아래 참고)
 *   npm run stop -- --status  지금 상태만 본다
 *   npm run stop -- --release 푼다
 *
 * **지금은 플래그만 세웁니다.** 미체결 주문 취소는 브로커 어댑터가 생긴 뒤에
 * 붙입니다(`engageEmergencyStop`에 broker를 넘기면 동작합니다). 그때까지도
 * 플래그만으로 다음 사이클의 신규 주문은 확실히 막힙니다.
 */

const dataDir = path.resolve(process.env.PAPER_DATA_DIR || "data");
const args = process.argv.slice(2);

if (args.includes("--status")) {
  const state = await readEmergencyStop(dataDir);
  console.log(state.stopped ? "🛑 중지 상태입니다." : "▶️  정상입니다(중지 아님).");
  if (state.since) console.log(`  걸린 시각: ${state.since}`);
  if (state.reason) console.log(`  사유: ${state.reason}`);
  console.log(`  파일: ${emergencyStopPath(dataDir)}`);
} else if (args.includes("--release")) {
  const result = await releaseEmergencyStop(dataDir);
  console.log(result.released ? "중지를 풀었습니다. 다음 사이클부터 매매가 재개됩니다." : result.reason);
} else {
  // --reason 뒤의 값을 사유로 씁니다. 없으면 기본 문구입니다.
  const index = args.indexOf("--reason");
  const reason = index >= 0 ? args[index + 1] : "수동 중지";

  const result = await engageEmergencyStop(dataDir, { reason });
  console.log("🛑 긴급 중지를 걸었습니다. 다음 사이클부터 신규 주문을 내지 않습니다.");
  console.log(`  사유: ${reason}`);
  console.log(`  파일: ${emergencyStopPath(dataDir)}`);
  if (result.canceled.length === 0 && result.failed.length === 0) {
    console.log(
      "\n  주의: 이미 시장에 나가 있는 주문은 취소하지 않았습니다.\n" +
        "  브로커 어댑터가 붙기 전이라 취소 경로가 없습니다. 필요하면 앱에서 직접 취소하십시오.",
    );
  }
  console.log("\n  풀 때: npm run stop -- --release");
}
