import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import {
  fetchFreeMarketNews,
  fetchBlueskyAuthorFeed,
  fetchGdeltNews,
  fetchOpinionRss,
  parseRss,
} from "../src/sentiment/free-news-fetcher.js";

const RSS = `<?xml version="1.0"?><rss><channel><item>
  <title>Federal Reserve issues FOMC statement</title>
  <link>https://www.federalreserve.gov/test.htm</link>
  <description><![CDATA[Inflation has cooled &amp; growth remains strong.]]></description>
  <pubDate>Tue, 21 Jul 2026 18:00:00 GMT</pubDate>
  <guid>fed-1</guid>
</item></channel></rss>`;

test("Fed RSS 제목·설명·날짜를 뉴스 입력 형식으로 바꾼다", () => {
  const [article] = parseRss(RSS);

  assert.equal(article.provider, "FED_RSS");
  assert.match(article.text, /Inflation has cooled & growth remains strong/);
  assert.equal(article.createdAt, "2026-07-21T18:00:00.000Z");
});

test("GDELT DOC JSON 기사 목록을 정규화한다", async () => {
  const articles = await fetchGdeltNews({
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get("mode"), "artlist");
      assert.equal(url.searchParams.get("format"), "json");
      return jsonResponse({
        articles: [{
          title: "Markets rally after inflation cools",
          url: "https://example.com/rally",
          domain: "example.com",
          seendate: "20260721T190000Z",
        }],
      });
    },
  });

  assert.equal(articles[0].provider, "GDELT");
  assert.equal(articles[0].createdAt, "2026-07-21T19:00:00Z");
});

test("Bluesky 공개 작성자 피드를 API 키 없이 정규화한다", async () => {
  const articles = await fetchBlueskyAuthorFeed("economist.example", {
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, "https://public.api.bsky.app");
      assert.equal(url.searchParams.get("actor"), "economist.example");
      assert.equal(options.headers.authorization, undefined);
      return jsonResponse({
        feed: [{
          post: {
            uri: "at://did:plc:test/app.bsky.feed.post/abc123",
            author: { handle: "economist.example" },
            record: { text: "Inflation is cooling", createdAt: "2026-07-21T19:00:00Z" },
            likeCount: 10,
            repostCount: 3,
          },
        }],
      });
    },
  });

  assert.equal(articles[0].provider, "BLUESKY");
  assert.equal(articles[0].metrics.like_count, 10);
  assert.equal(articles[0].url, "https://bsky.app/profile/economist.example/post/abc123");
});

test("선택한 개인 RSS를 전문가 의견으로 구분한다", async () => {
  const [article] = await fetchOpinionRss("https://writer.example/feed", {
    fetchImpl: async () => new Response(RSS, { status: 200 }),
  });

  assert.equal(article.provider, "OPINION_RSS");
  assert.equal(article.domain, "writer.example");
});

test("Fed와 GDELT를 합쳐 캐시하며 일부 소스 장애를 격리한다", async () => {
  const dataDir = await mkdtemp(path.join(process.cwd(), ".free-news-test-"));
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).includes("broken-feed")) return new Response("error", { status: 503 });
    if (String(url).includes("federalreserve")) {
      return new Response(RSS, { status: 200, headers: { "content-type": "application/xml" } });
    }
    return jsonResponse({
      articles: [{ title: "Recession risk weighs on markets", url: "https://example.com/risk" }],
    });
  };

  try {
    const options = {
      dataDir,
      fedFeeds: ["https://www.federalreserve.gov/feed.xml", "https://broken-feed.test/rss"],
      now: new Date("2026-07-21T19:00:00Z"),
      fetchImpl,
    };
    const first = await fetchFreeMarketNews(options);
    const second = await fetchFreeMarketNews({
      ...options,
      now: new Date("2026-07-21T19:05:00Z"),
    });

    assert.equal(first.resultCount, 2);
    assert.deepEqual(first.sourceCounts, { FED_RSS: 1, GDELT: 1 });
    assert.match(first.warning, /503/);
    assert.equal(second.source, "CACHE");
    assert.equal(calls, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("소스별로 성패를 남긴다 — 죽은 것만 적으면 원래 없었는지 가릴 수 없다", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");

  const dataDir = await mkdtemp(nodePath.join(tmpdir(), "news-health-"));
  const fetchImpl = async (url) => {
    const href = String(url);
    // GDELT만 네트워크 단계에서 죽는 상황입니다(2026-08-07 실제 경로).
    if (href.includes("gdeltproject")) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return "<rss><channel><item><title>Fed holds rates</title>"
          + "<link>https://federalreserve.gov/a</link></item></channel></rss>";
      },
      async json() { return { feed: [] }; },
    };
  };

  const snapshot = await fetchFreeMarketNews({
    dataDir, fetchImpl,
    fedFeeds: ["https://federalreserve.gov/feed"],
    blueskyAuthors: [],
    opinionFeeds: [],
  });

  const gdelt = snapshot.sourceHealth.find((item) => item.source === "GDELT");
  assert.equal(gdelt.ok, false);
  // Node는 네트워크 실패를 전부 "fetch failed"로 감싸고 진짜 이유를 cause에 넣는다.
  // 메시지만 남기면 DNS 실패인지 연결 거부인지 알 수 없다.
  assert.match(gdelt.error, /ENOTFOUND/);

  const fed = snapshot.sourceHealth.find((item) => item.source === "FED_RSS");
  assert.equal(fed.ok, true, "살아 있는 소스도 함께 남는다");
  assert.ok(fed.articles > 0);
});
