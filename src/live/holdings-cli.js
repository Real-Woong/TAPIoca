#!/usr/bin/env node

/**
 * 토스 `/api/v1/holdings` **원본 응답**을 그대로 봅니다 — 읽기만 합니다.
 *
 * 보고서의 «실계좌 손익»은 `normalizeHolding`이 고른 필드(달러뿐)만 쓰는데,
 * 토스 앱은 원화 손익을 보여줍니다(2026-10-10 두 숫자가 달랐습니다). 응답에
 * 원화 필드가 있는데 우리가 안 읽는 건지, 아예 없는 건지를 가리려고 만들었습니다.
 *
 *   npm run live:holdings               원본 JSON + 키 목록
 *   npm run live:holdings -- --symbol IWM
 *
 * 주문·저장은 하지 않습니다. 조회뿐입니다.
 * **출력에 관리 3종목 밖의 보유도 나옵니다** — 계좌 전체 응답이라서입니다.
 */

import { createTossClientFromEnv } from "../toss/toss-client.js";
import { createTossBroker } from "./toss-broker.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

/** 중첩 객체를 `a.b.c = 값` 줄로 폅니다. 키 이름만 훑어 원화 필드를 찾기 쉽게 합니다. */
function flatten(value, prefix = "", out = []) {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.push([prefix, value]);
  }
  return out;
}

async function resolveAccountSeq(client) {
  const configured = Number(process.env.TOSS_ACCOUNT_SEQ);
  if (Number.isInteger(configured) && configured > 0) return configured;

  const accounts = await client.getAccounts();
  if (accounts.length === 0) throw new Error("계좌를 찾지 못했습니다.");
  if (accounts.length === 1) return accounts[0].accountSeq;
  throw new Error(
    `계좌가 ${accounts.length}개입니다. TOSS_ACCOUNT_SEQ로 어느 계좌인지 지정하십시오 `
    + `(${accounts.map((account) => account.accountSeq).join(", ")}).`,
  );
}

async function main() {
  const symbolFilter = argValue("--symbol")?.trim().toUpperCase() || null;

  const client = createTossClientFromEnv();
  const broker = createTossBroker({
    getAccessToken: () => client.getAccessToken(),
    accountSeq: await resolveAccountSeq(client),
  });

  const raw = await broker.getHoldings();
  const items = Array.isArray(raw) ? raw : (raw?.holdings ?? raw?.items ?? raw?.positions ?? null);

  console.log("\n■ holdings 원본 (읽기 전용)\n");

  if (!Array.isArray(items)) {
    console.log("응답이 배열이 아닙니다 — 그대로 찍습니다.");
    console.log(JSON.stringify(raw, null, 2));
    return;
  }

  const rows = symbolFilter ? items.filter((item) => item?.symbol === symbolFilter) : items;
  console.log(`종목 ${rows.length}개${symbolFilter ? ` (필터: ${symbolFilter})` : ""}\n`);
  console.log(JSON.stringify(rows, null, 2));

  // 원화 필드를 눈으로 찾는 수고를 줄입니다. 이름에 krw가 든 키와 환율 키만 따로 모읍니다.
  const hints = rows.flatMap((item) =>
    flatten(item)
      .filter(([key]) => /krw|won|exchange|fx|rate|currency/i.test(key))
      .map(([key, value]) => `  ${item?.symbol ?? "?"}  ${key} = ${value}`),
  );
  console.log("\n■ 원화·환율로 보이는 키");
  console.log(hints.length ? hints.join("\n") : "  없음 — 응답에 원화/환율 필드가 없습니다.");
  console.log("");
}

await main();
