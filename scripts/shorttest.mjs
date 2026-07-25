#!/usr/bin/env node

// 테스트를 테마(파일)별로 돌려 "pass/전체"만 한눈에 보여주는 요약 러너입니다.
// 각 파일을 TAP 리포터로 실행해 요약 줄(# pass / # fail / # tests)만 파싱합니다.
// 실패가 있으면 종료 코드 1을 반환하므로 배포 전 검사에도 그대로 쓸 수 있습니다.

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const testDir = path.resolve("test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort();

// 파일명 → 읽기 좋은 테마 라벨
const LABELS = {
  "paper-engine.test.js": "매매엔진(리밸런싱·비용·벤치마크)",
  "market-signal.test.js": "신호결합(추세·변동성)",
  "trend-signal.test.js": "추세·변동성",
  "event-log.test.js": "이벤트로그",
  "exit-strategy.test.js": "청산전략",
  "daily-report.test.js": "일일리포트",
  "macd-signal.test.js": "MACD",
  "macro-regime.test.js": "거시·레짐",
  "macro-snapshot.test.js": "거시캐시",
  "market-sentiment.test.js": "감성결합",
  "sentiment-analyzer.test.js": "감성분석",
  "free-news-fetcher.test.js": "뉴스수집",
  "toss-client.test.js": "Toss API",
  "trading-budget.test.js": "예산·주문",
  "us-market-session.test.js": "장시간",
  "portfolio-analysis.test.js": "포트폴리오",
  "fred-client.test.js": "FRED",
  "telegram-client.test.js": "텔레그램",
};

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--test", "--test-reporter=tap", path.join("test", file)],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", () => {
      const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0);
      const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0);
      const total = Number(/^# tests (\d+)/m.exec(out)?.[1] ?? pass + fail);
      const failedNames = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
      resolve({ file, pass, fail, total, failedNames });
    });
  });
}

const results = (await Promise.all(files.map(runFile))).sort((a, b) => a.file.localeCompare(b.file));

let totalPass = 0;
let totalFail = 0;
let totalAll = 0;

console.log("\n📋 테스트 요약 (테마별 pass/전체)\n");
for (const result of results) {
  totalPass += result.pass;
  totalFail += result.fail;
  totalAll += result.total;
  const mark = result.fail === 0 ? "✔" : "✖";
  const count = `${result.pass}/${result.total}`.padStart(7);
  const label = LABELS[result.file] ?? result.file.replace(".test.js", "");
  console.log(`  ${mark} ${count}  ${label}`);
  for (const name of result.failedNames) {
    console.log(`          └ 실패: ${name}`);
  }
}

console.log("  " + "─".repeat(42));
const summaryCount = `${totalPass}/${totalAll}`.padStart(7);
if (totalFail === 0) {
  console.log(`  ✅ ${summaryCount}  전체 통과`);
} else {
  console.log(`  ❌ ${summaryCount}  실패 ${totalFail}건`);
  process.exitCode = 1;
}
console.log("");
