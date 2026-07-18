import test from "node:test";
import assert from "node:assert/strict";

import { TossApiError, TossInvestClient } from "../src/toss/toss-client.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("토큰, 계좌, 전체 보유 종목을 순서대로 조회한다", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth2/token")) {
      return jsonResponse({ access_token: "test-token", token_type: "Bearer", expires_in: 86400 });
    }
    if (url.endsWith("/api/v1/accounts")) {
      return jsonResponse({
        result: [{ accountNo: "12345678901", accountSeq: 1, accountType: "BROKERAGE" }],
      });
    }
    if (url.endsWith("/api/v1/holdings")) {
      return jsonResponse({
        result: { items: [{ symbol: "005930", quantity: "10" }] },
      });
    }
    throw new Error(`예상하지 못한 URL: ${url}`);
  };
  const client = new TossInvestClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl,
  });

  const result = await client.getPortfolio();

  assert.equal(result.accounts[0].holdings.items[0].symbol, "005930");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.headers.authorization, "Bearer test-token");
  assert.equal(calls[2].options.headers["X-Tossinvest-Account"], "1");
  assert.match(String(calls[0].options.body), /grant_type=client_credentials/);
});

test("한 프로세스에서는 유효한 토큰을 재사용한다", async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/token")) {
      tokenCalls += 1;
      return jsonResponse({ access_token: "test-token", token_type: "Bearer", expires_in: 86400 });
    }
    return jsonResponse({ result: [] });
  };
  const client = new TossInvestClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl,
  });

  await client.getAccounts();
  await client.getAccounts();

  assert.equal(tokenCalls, 1);
});

test("동시 API 요청도 하나의 토큰 발급 작업을 공유한다", async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/token")) {
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ access_token: "shared-token", token_type: "Bearer", expires_in: 86400 });
    }
    return jsonResponse({ result: [] });
  };
  const client = new TossInvestClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl,
  });

  await Promise.all([
    client.getPrices(["VTI"]),
    client.getExchangeRate(),
    client.getAccounts(),
  ]);

  assert.equal(tokenCalls, 1);
});

test("여러 종목 현재가는 종목별 단일 요청으로 조회한다", async () => {
  const priceUrls = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/token")) {
      return jsonResponse({ access_token: "test-token", token_type: "Bearer", expires_in: 86400 });
    }
    priceUrls.push(url);
    return jsonResponse({ result: { symbol: new URL(url).searchParams.get("symbols") } });
  };
  const client = new TossInvestClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl,
  });

  const prices = await client.getPrices(["VTI", "SCHD"]);

  assert.deepEqual(prices.map((price) => price.symbol), ["VTI", "SCHD"]);
  assert.match(priceUrls[0], /symbols=VTI/);
  assert.match(priceUrls[1], /symbols=SCHD/);
});

test("환율 조회는 USD 기준통화와 KRW 상대통화를 명시한다", async () => {
  let exchangeRateUrl;
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/token")) {
      return jsonResponse({ access_token: "test-token", token_type: "Bearer", expires_in: 86400 });
    }
    exchangeRateUrl = url;
    return jsonResponse({ result: { baseCurrency: "USD" } });
  };
  const client = new TossInvestClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl,
  });

  await client.getExchangeRate();

  assert.equal(new URL(exchangeRateUrl).searchParams.get("baseCurrency"), "USD");
  assert.equal(new URL(exchangeRateUrl).searchParams.get("quoteCurrency"), "KRW");
});

test("API 오류의 코드와 requestId를 보존한다", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/oauth2/token")) {
      return jsonResponse({ access_token: "test-token", token_type: "Bearer", expires_in: 86400 });
    }
    return jsonResponse(
      { error: { code: "account-not-found", message: "계좌가 없습니다.", requestId: "req-1" } },
      404,
    );
  };
  const client = new TossInvestClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl,
  });

  await assert.rejects(client.getAccounts(), (error) => {
    assert.ok(error instanceof TossApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "account-not-found");
    assert.equal(error.requestId, "req-1");
    return true;
  });
});
