#!/usr/bin/env node

import { createTossClientFromEnv, TossApiError } from "./toss-client.js";

try {
  const client = createTossClientFromEnv();
  const accounts = await client.getAccounts();

  console.log("Toss Open API 연결에 성공했습니다.");
  console.log(`조회 가능한 종합매매 계좌: ${accounts.length}개`);
  console.log("안전 모드: 조회 전용 (주문 API를 호출하지 않음)");
} catch (error) {
  console.error("Toss Open API 연결 진단에 실패했습니다.");

  if (error instanceof TossApiError) {
    console.error(`원인: ${error.message}`);
    if (error.code) console.error(`오류 코드: ${error.code}`);
    if (error.requestId) console.error(`요청 ID: ${error.requestId}`);
    if (error.status === 401) {
      console.error("TOSS_CLIENT_ID와 TOSS_CLIENT_SECRET을 다시 확인하세요.");
    }
    if (error.status === 403) {
      console.error("현재 공인 IP가 WTS의 Open API 허용 IP에 등록됐는지 확인하세요.");
    }
  } else {
    console.error(`원인: ${error.message}`);
  }

  process.exitCode = 1;
}
