# TAPIoca🧋

토스증권 Open API로 계좌와 시장을 읽고, 신호 층을 결합해 목표 비중을 정하고,
PAPER 장부로 검증하는 자동매매 실험입니다.

**실주문 실행 계층이 있습니다.** 2026-08-07에 실계좌로 첫 주문을 냈습니다.
다만 **자동으로 주문이 나가지는 않습니다** — 예약 실행기(`paper:run`)는 PAPER
모드가 아니면 거부하고, 실주문은 사람이 `npm run live:probe -- --confirm`을
직접 칠 때만 나갑니다.

- 지금 무엇이 참인가 → [`STRATEGY.md`](STRATEGY.md)
- 무슨 일이 있었나 → [`develope-log/`](develope-log/)
- 코드가 어떻게 생겼나 → [`file_structure.md`](file_structure.md)

## 소스 폴더 구조

```text
src/
├── toss/          # Toss 인증, 계좌·시세 API와 연결 진단
├── live/          # 실주문 실행 — 브로커 계약, 원장, 슬리피지, 긴급 중지
├── portfolio/     # 보유 종목 조회와 포트폴리오 분석
├── market/        # 추세·MACD 신호, 미국 정규장 시간 판정
├── sentiment/     # 무료 뉴스 수집, 로컬 감성 분석, 신호 결합과 목표 비중
├── FRED_data/     # 미국 경제지표 수집과 거시경제 상태 판정
├── paper/         # PAPER 장부, 매매 정책, 이벤트 로그, 사후 분석
├── backtest/      # 실데이터 백테스터, 일봉·FRED 개정이력 캐시
└── telegram/      # Telegram 전송과 일일 보고서
```

## 1. 설정

Node.js 20.12 이상이 필요합니다. 별도 패키지 설치는 필요하지 않습니다.

프로젝트 루트에 `.env`를 만들고 토스증권 WTS에서 발급한 `Client ID`,
`Client Secret`을 넣습니다. `.env`와 `.env.*`는 모두 `.gitignore`에 있습니다 —
저장소가 공개라 백업본 하나만 새어나가도 키가 노출됩니다.
Secret을 채팅, Git, 로그에 남기지 마세요. 실행할 컴퓨터/서버의 공인 IP도 WTS의
`Open API > 허용 IP 관리`에 등록되어 있어야 합니다.

## 2. 전체 보유 주식 조회

먼저 비밀값이나 계좌 상세를 출력하지 않는 연결 진단을 실행합니다.

```bash
npm run doctor
```

연결에 성공하면 전체 보유 주식을 조회합니다.

```bash
npm run portfolio              # 사람이 읽는 요약
npm run portfolio -- --json    # 원본 JSON
npm run portfolio -- --symbol 005930
npm run portfolio -- --symbol AAPL --json
```

JSON의 금액·수량·수익률은 토스 API 원본처럼 문자열로 유지됩니다. 금융 숫자를
JavaScript `number`로 바꾸면서 생길 수 있는 정밀도 손실을 피하기 위한 설계입니다.

## 3. 포트폴리오 구조 분석

통화별 평가액, 종목 비중과 집중도 지수(HHI)를 조회합니다. 단일 종목 비중이
40% 이상이면 주의 문구를 표시합니다.

```bash
npm run analyze
npm run analyze -- --json
```

## 4. 신호 층과 가중치

목표 비중은 네 층의 점수를 더해 정합니다.

```text
합산점수 = 거시 × MACRO_SCORE_WEIGHT
         + 감성 × 감성신뢰도 × SENTIMENT_SCORE_WEIGHT × 신선도
         + 추세 × 추세신뢰도 × TREND_SCORE_WEIGHT
         + MACD × MACD신뢰도 × MACD_SCORE_WEIGHT
```

합산점수는 RISK_OFF / NEUTRAL / RISK_ON 표 사이를 **연속적으로** 보간해 목표
주식 비중이 되고, 실현 변동성이 목표를 넘으면 그만큼 노출을 줄입니다.

**현재 가중치 기본값입니다.**

```dotenv
MACRO_SCORE_WEIGHT=0        # 판정 결과 배분에서 제외 (2026-08-08)
SENTIMENT_SCORE_WEIGHT=0    # 판정 전까지 0 (표본은 계속 쌓음)
TREND_SCORE_WEIGHT=1        # 유일하게 배분을 움직이는 층
MACD_SCORE_WEIGHT=0         # 계산·기록은 하되 판단에는 쓰지 않음
```

가중치가 0인 층도 **점수는 계속 계산되고 이벤트 로그에 남습니다.** 배분에만
관여하지 않을 뿐이라, 표본이 쌓이면 언제든 다시 판정할 수 있습니다.

이 값들을 왜 이렇게 두었는지, 무엇을 재서 정했는지는 [`STRATEGY.md`](STRATEGY.md)에
있습니다. **바꾸기 전에 `npm run backtest`로 먼저 재십시오.**

## 5. PAPER 매매 정책

자동매매 대상은 미국 ETF로 제한하고, 에이전트 실행 전에 보유하던 모든 종목은
보호합니다. 봇이 새로 매수해 장부에 기록한 수량만 청산 대상이 됩니다.

```dotenv
LIVE_TRADING=false
TRADING_CURRENCY=USD
# 원금은 코드에서도 100,000원으로 고정되어 이보다 크거나 작게 초기화할 수 없습니다.
TRADING_BUDGET_KRW=100000
MAX_ORDER_USD=5
MIN_ORDER_USD=1
MAX_DAILY_BUY_USD=10
MAX_TOTAL_LOSS_USD=10
MAX_DAILY_LOSS_USD=3
REENTRY_COOLDOWN_HOURS=24
# 재난 방어용 손절선입니다. 예전 값(0.03)은 지수 ETF의 일상적 변동에 걸려
# 목표 비중 레이어가 "70% 보유"라고 말하는 동안 포지션을 비웠습니다.
STOP_LOSS_RATE=0.12
# 레짐 확정에 필요한 거래일 수입니다(내부에서 15분 사이클 수로 환산).
REGIME_CONFIRM_DAYS=1
ALLOW_SELL_EXISTING=false
```

`TRAILING_ACTIVATION_RATE`·`TRAILING_DRAWDOWN_RATE`·`MAX_HOLDING_DAYS`는
**기본적으로 꺼져 있습니다.** 개별 종목 모멘텀 매매용 규칙이라 광역 지수 ETF에서는
목표 비중 레이어와 충돌합니다. 켜려면 값을 적고, 다시 끄려면 `off`를 적으십시오.

```dotenv
# 개별 종목 워치리스트에서만 권장합니다.
TRAILING_ACTIVATION_RATE=0.025
TRAILING_DRAWDOWN_RATE=0.015
MAX_HOLDING_DAYS=15
```

손실 한도(`MAX_TOTAL_LOSS_USD`·`MAX_DAILY_LOSS_USD`)는 **매매를 멈추지 않고 경고만**
보냅니다. 자동 중단은 폭락 중에 위험관리를 꺼버려 오히려 낙폭을 키웠습니다
(실데이터 20년에서 MDD 29.8% → 51.6%). 대응은 사람이 판단합니다.

기본값은 전략의 수익성을 보장하지 않습니다.

## 6. PAPER 실행

PAPER 장부를 최초 100,000원 상당의 USD로 한 번만 초기화하고 한 사이클 실행합니다.
이후 실행은 같은 장부를 이어서 사용합니다.

```bash
npm run paper:run
npm run paper:status
npm run paper:events      # 사이클 이벤트 로그
npm run paper:signals     # 감성 시계열 통계 (판정용)
npm run paper:alpha       # 알파를 "의도한 비용"과 "결함"으로 분해
```

`paper:run`은 뉴욕 현지시간 기준 평일 정규장(09:30~16:00)에만 토큰을 발급하고
시장을 조회합니다. `America/New_York` 시간대를 사용하므로 서머타임 전환은 자동으로
반영됩니다. 장외 시간에 수동 진단이 꼭 필요할 때만 `--force`를 씁니다.

```bash
npm run paper:run -- --force
```

Oracle에서 15분마다 자동 실행하려면 `deploy/`의 systemd 서비스와 타이머를
사용합니다. 서비스는 `data/`만 쓸 수 있고 `.env`는 읽기 전용으로 사용합니다.
배포 절차는 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)에 있습니다 — 서버에는 코드만
보내고 `.env`·`data/`는 절대 덮어쓰지 않습니다.

## 7. 실주문 (사람이 직접 실행)

**주문이 나가는 유일한 경로입니다.** 타이머도, PAPER 실행기도 주문을 내지
않습니다.

```bash
npm run live:probe                       # 확인만 한다 — 주문 안 나감
npm run live:probe -- --symbol SCHD --amount 2 --confirm
npm run live:slippage                    # 원장에 쌓인 실제 체결의 슬리피지
npm run stop                             # 긴급 중지 (data/EMERGENCY_STOP)
```

`--confirm` 없이는 어떤 주문도 나가지 않습니다. 실제 돈이 나가는 명령의
기본값은 "아무 일도 안 함"이어야 하기 때문입니다.

안전장치는 다음과 같습니다.

- **원장은 덧붙이기 전용**(`data/live-orders.jsonl`)이고 고치지 않습니다. 상태는
  저장하지 않고 매번 로그에서 다시 계산하므로, 저장된 상태와 로그가 어긋날 수
  없습니다.
- **미결 주문이 하나라도 있으면 다음 주문을 내지 않습니다.**
- **모르는 주문 상태값은 멈추고 사람을 부릅니다.** 토스가 "알 수 없는 상태값도
  허용하라"고 명시하므로, 임의로 접어 넣으면 조용히 틀린 판단을 하게 됩니다.
- **재제출 가능 여부는 한 곳에서만 정합니다**(`order-outcome.js`). 호출부마다
  판단하면 언젠가 중복 매수가 됩니다.
- **대사 대상은 계좌 전체가 아니라 "기준선 + 우리가 체결시킨 것"입니다.** 계좌에
  이미 다른 자산이 있어서(2026-08-07 확인) 전체로 대사하면 영구 정지합니다.
- **긴급 중지는 환경변수가 아니라 파일입니다.** 재시작 없이 다음 사이클부터
  즉시 듣습니다.

첫 실주문에서 무엇을 배웠는지는
[`develope-log/2026-08-07_첫-실주문.md`](develope-log/2026-08-07_첫-실주문.md)에
있습니다.

## 8. FRED 거시경제 지표

[FRED API](https://fred.stlouisfed.org/docs/api/fred/)에서 무료 API 키를 발급받아
`.env`에 추가합니다. 키는 Git이나 로그에 남기지 마세요.

```dotenv
FRED_API_KEY="발급받은 API 키"
```

연준 기준금리, 근원 PCE, 실업률, Sahm 지표, 장단기 금리차를 조회해
`RISK_ON` / `NEUTRAL` / `RISK_OFF` 상태와 목표 비중을 출력합니다.

```bash
npm run macro:status
```

PAPER 실행기는 FRED 결과를 `data/macro-snapshot.json`에 6시간 캐시합니다.
`RISK_ON`은 IWM을 일부 포함하고, `NEUTRAL`은 VTI·SCHD와 현금 10%, `RISK_OFF`는
IWM을 제외하고 현금 40%를 목표로 합니다. 거시 신호만으로 즉시 매도하지는
않습니다. FRED와 캐시를 모두 쓸 수 없을 때는 청산 판단만 하고 신규 매수는
중단합니다.

`MACRO_SCORE_WEIGHT` 기본값이 0이므로 **현재 이 점수는 배분을 움직이지 않습니다.**
계산과 기록은 그대로 합니다.

## 9. API 키 없는 뉴스·전문가 의견 감성

Federal Reserve 공식 RSS, GDELT DOC 2.0, Google News RSS를 병렬로 수집합니다.
선택한 Bluesky 공개 작성자 피드와 Substack·개인 블로그 RSS도 함께 수집할 수
있습니다. 모든 소스는 API 키가 필요 없습니다.

결과는 `data/free-news-cache.json`에 기본 60분간 저장합니다. 감성은 일 단위 판단에
쓰이므로 15분 신선도가 필요 없고, 15분(PAPER 사이클과 동일)일 때는 GDELT를 하루
약 96번 호출해 429를 맞았습니다. **소스마다 성공·실패를
스냅샷에 기록하므로 죽은 소스가 조용히 표본을 줄이지 않습니다.** 모든 소스가
실패하면 마지막 캐시를 `stale` 상태로 쓰고, 캐시도 없으면 뉴스 층을 제외합니다.

```dotenv
SENTIMENT_PROVIDER=local
SENTIMENT_SCORE_WEIGHT=0
NEWS_MAX_RECORDS=75
NEWS_CACHE_MINUTES=60
BLUESKY_AUTHORS=economist.example,analyst.bsky.social
OPINION_RSS_FEEDS=https://writer.substack.com/feed,https://example.com/rss.xml
OPINION_SCORE_WEIGHT=0.1
# 선택: 기본 경제뉴스 검색식을 바꿀 때만 설정
# NEWS_QUERY=("Federal Reserve" OR FOMC OR inflation OR recession)
```

`BLUESKY_AUTHORS`에는 `@` 없이 공개 계정 핸들을 적습니다. `OPINION_RSS_FEEDS`에는
작성자가 직접 공개한 RSS 주소만 등록합니다. 전문가 의견은 사실 보도와 분리해서
분석하며 기본적으로 공식 뉴스 대비 10%만 보조 반영합니다. 공식 뉴스가 하나도 없으면
전문가 의견 신뢰도 자체를 10%로 제한합니다.

`local` 분석기는 프로젝트 안에서 실행되는 단어·문맥·부정어 기반 점수기이므로
외부 LLM API를 호출하지 않고 비용이 0원입니다. 반환값은 `sentiment_score`,
`confidence`, `summary_reason`, `bullish_signals`, `bearish_signals`의 고정 JSON
구조를 검증합니다.

로컬 LLM을 쓰려면 Ollama 설치 후 다음과 같이 바꿉니다. 외부 API 요금은 없지만
로컬 CPU/GPU 자원을 씁니다.

```dotenv
SENTIMENT_PROVIDER=ollama
OLLAMA_MODEL=qwen3:4b
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

어떤 소스가 답했고 표본이 얼마나 오래됐는지 확인합니다.

```bash
npm run sentiment:status
```

## 10. 추세와 MACD

- **추세**는 Faber(2007) 이동평균 필터입니다. 200일 평균 대비 위치를 `tanh`로
  점수화해 종목별로 합칩니다. 일봉은 Twelve Data → Yahoo → Stooq 순으로
  받는데, Oracle 호스트에서는 키 없는 두 소스가 막혀 있어 실질적으로
  `TWELVE_DATA_API_KEY`가 필요합니다.
- **MACD**는 캐시된 일봉으로 12·26·9를 계산합니다. 34개 표본이 쌓이기 전에는
  준비 중으로 표시됩니다.

기본 MACD 가중치는 `0`입니다. 예전 기본값 `0.15`의 실제 기여도는 +0.029였는데,
배분이 갈리는 지점이 ±1.5이므로 **어떤 값이 나와도 결정을 바꿀 수 없는
크기**였습니다. 백테스트에서도 0 / 0.15 / 0.5 / 1.0 사이에 일관된 차이가 없었습니다.

일봉 수집·추세·MACD를 한 번에 점검합니다. 실제 캐시와 PAPER 장부는 건드리지
않습니다.

```bash
npm run signals:check
npm run market:check      # 환율과 ETF 현재가 응답 형식
```

## 11. 백테스트

파라미터는 **여기서** 정합니다. PAPER 20거래일 × $67로는 경로 의존 규칙의
효과를 잡음과 구분할 수 없습니다.

```bash
npm run backtest                              # 합성 시나리오
npm run backtest -- --compare strategy        # 신호 스택 vs 정적 배분
npm run backtest -- --compare macd|band|cost|trend|exit
npm run backtest:fetch                        # 실제 일봉 캐시
npm run backtest:fetch-macro                  # FRED 개정 이력 캐시
npm run backtest -- --source cache            # 실데이터로 백테스트
```

백테스터는 **운영 코드 그대로** 돌립니다. 거시 층은 FRED 개정 이력(vintage)으로
"그날 알 수 있었던 값"만 써서 되살립니다 — 지금 조회한 확정치를 넣으면 미래를
보고 매매한 것이 되고, **결과가 좋게 나오기 때문에 눈에 안 띕니다.**

뉴스 감성은 백테스트에 넣지 않습니다. 가격·추세·MACD·FRED는 언제든 다시 받을
수 있지만 **뉴스 감성 창은 되살릴 수 없어서**, `paper:signals`가 실운영에서
쌓는 로그가 이 층을 언젠가 백테스트할 유일한 길입니다.

## 12. Telegram 보고

Telegram 봇 토큰과 채팅 ID를 `.env`에 설정하면 뉴욕 정규장 종료 10분 후 일일
PAPER 보고서를 한 번 전송합니다.

```dotenv
TELEGRAM_BOT_TOKEN="BotFather가 발급한 토큰"
TELEGRAM_CHAT_ID="채팅 ID"
```

```bash
npm run telegram:discover
npm run telegram:test
npm run telegram:report -- --force
```

## 13. 테스트

```bash
npm test              # 요약 출력
npm run test:verbose  # 테스트별 출력
```

---

토스증권 공식 문서: <https://developers.tossinvest.com/docs>
API 원문 사본: [`toss-guideline/`](toss-guideline/)
