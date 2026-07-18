#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { summarizePaperState } from "./paper-engine.js";

const statePath = path.resolve(process.env.PAPER_DATA_DIR || "data", "paper-state.json");

try {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const summary = summarizePaperState(state);
  // 마지막 매매에 사용한 거시경제 판정도 상태 조회에서 함께 확인합니다.
  console.log(JSON.stringify({ lastRunAt: state.lastRunAt, macro: state.macro ?? null, ...summary }, null, 2));
} catch (error) {
  if (error.code === "ENOENT") {
    console.error("PAPER 장부가 없습니다. 먼저 npm run paper:run을 실행하세요.");
  } else {
    console.error(`오류: ${error.message}`);
  }
  process.exitCode = 1;
}
