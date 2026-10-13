import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { krwReturn, loadKrwCostBasis } from "../src/portfolio/krw-cost.js";

const basis = { positions: { BAC: { quantity: 6, avgKrw: 90637 } } };

test("앱 방식: (기준환율 평가금 - 원화 매입금) / 원화 매입금", () => {
  // 2026-10-13 토스 앱 BAC: 평가 439,288원, 수익률 -19.22%
  const result = krwReturn({ symbol: "BAC", quantity: "6", valueKrw: 439288 }, basis);

  assert.equal(result.status, "ok");
  assert.equal(result.costKrw, 543822);
  assert.equal(Math.round(result.rate * 10000) / 100, -19.22);
  assert.equal(Math.round(result.profitKrw), -104534);
});

test("일부 매도해 수량이 줄면 평균 단가 그대로 남은 수량만 계산한다", () => {
  const result = krwReturn({ symbol: "BAC", quantity: 3, valueKrw: 250000 }, basis);

  assert.equal(result.status, "ok");
  assert.equal(result.costKrw, 3 * 90637);
});

test("수량이 등록값보다 늘면 틀린 수익률을 만들지 않는다", () => {
  assert.equal(krwReturn({ symbol: "BAC", quantity: 7, valueKrw: 500000 }, basis).status, "stale");
});

test("등록되지 않은 종목과 등록부가 없을 때는 missing", () => {
  assert.equal(krwReturn({ symbol: "BOTZ", quantity: 1, valueKrw: 1000 }, basis).status, "missing");
  assert.equal(krwReturn({ symbol: "BAC", quantity: 1, valueKrw: 1000 }, null).status, "missing");
});

test("등록부 파일이 없으면 null, 형식이 틀리면 던진다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "krw-cost-"));
  assert.equal(await loadKrwCostBasis(dir), null);

  await writeFile(path.join(dir, "krw-cost-basis.json"), JSON.stringify({ positions: {} }));
  assert.deepEqual(await loadKrwCostBasis(dir), { positions: {} });

  await writeFile(path.join(dir, "krw-cost-basis.json"), JSON.stringify({ nope: 1 }));
  await assert.rejects(loadKrwCostBasis(dir), /positions/);
});
