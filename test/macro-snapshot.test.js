import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { loadMacroSignal } from "../src/FRED_data/macro-snapshot.js";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("FRED 판정을 저장하고 캐시가 최신이면 네트워크를 다시 호출하지 않는다", async () => {
  const dataDir = await mkdtemp(path.join(process.cwd(), ".macro-test-"));
  let calls = 0;
  const values = {
    DFEDTARL: "3.5",
    DFEDTARU: "3.75",
    PCEPILFE: "2.7",
    UNRATE: "4.3",
    SAHMREALTIME: "0.1",
    T10Y2Y: "0.3",
  };
  const fetchImpl = async (url) => {
    calls += 1;
    const seriesId = url.searchParams.get("series_id");
    return jsonResponse({
      observations: [{ date: "2026-07-15", value: values[seriesId] }],
    });
  };

  try {
    const first = await loadMacroSignal({
      dataDir,
      apiKey: "test-key",
      now: new Date("2026-07-15T10:00:00Z"),
      fetchImpl,
    });
    const second = await loadMacroSignal({
      dataDir,
      apiKey: "test-key",
      now: new Date("2026-07-15T11:00:00Z"),
      fetchImpl,
    });

    assert.equal(first.source, "FRED");
    assert.equal(second.source, "CACHE");
    assert.equal(calls, 6);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
