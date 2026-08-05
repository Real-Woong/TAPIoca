# TAPIoca🧋

토스증권 Open API에서 내 계좌와 국내·미국 보유 주식을 읽어 오는 1단계 구현입니다.
현재 코드는 **조회 전용**이며 주문을 생성하지 않습니다.

## 소스 폴더 구조

`src`는 공부할 때 기능의 경계를 쉽게 찾을 수 있도록 다음과 같이 나눴습니다.

```text
src/
├── toss/          # Toss 인증, 계좌·시세 API와 연결 진단
├── portfolio/     # 보유 종목 조회와 포트폴리오 분석
├── market/        # 시장가격 진단과 미국 정규장 시간 판정
├── paper/         # PAPER 장부, 매매 정책, 진입·청산 계산
├── telegram/      # Telegram 전송과 일일 보고서
├── sentiment/     # Fed RSS·GDELT 뉴스 수집, 무료 로컬 감성 분석, FRED 점수 결합
└── FRED_data/     # 미국 경제지표 수집과 거시경제 상태 판정
```

## 1. 설정

Node.js 20.12 이상이 필요합니다. 별도 패키지 설치는 필요하지 않습니다.

```bash
cp .env.example .env
```

`.env`에 토스증권 WTS에서 발급한 `Client ID`, `Client Secret`을 입력합니다.
Secret을 채팅, Git, 로그에 남기지 마세요. 실행할 컴퓨터/서버의 공인 IP도 WTS의
`Open API > 허용 IP 관리`에 등록되어 있어야 합니다.

## 2. 전체 보유 주식 조회

먼저 비밀값이나 계좌 상세를 출력하지 않는 연결 진단을 실행합니다. 이 명령은
인증 후 계좌 개수만 확인하며 주문 API를 호출하지 않습니다.

```bash
npm run doctor
```

연결에 성공하면 전체 보유 주식을 조회합니다.

사람이 읽기 쉬운 요약:

```bash
npm run portfolio
```

AI 파이프라인에서 사용할 원본 JSON:

```bash
npm run portfolio -- --json
```

특정 종목만 조회:

```bash
npm run portfolio -- --symbol 005930
npm run portfolio -- --symbol AAPL --json
```

JSON의 금액·수량·수익률은 토스 API 원본처럼 문자열로 유지됩니다. 금융 숫자를
JavaScript `number`로 바꾸면서 생길 수 있는 정밀도 손실을 피하기 위한 설계입니다.

## 3. 포트폴리오 구조 분석

통화별 평가액, 종목 비중과 집중도 지수(HHI)를 조회합니다. 주문 API는 호출하지
않으며, 단일 종목 비중이 40% 이상이면 주의 문구를 표시합니다.

```bash
npm run analyze
npm run analyze -- --json
```

## PAPER 청산 정책

자동매매 대상은 미국 ETF로 제한하고, 에이전트 실행 전에 보유하던 모든 종목은
보호합니다. 봇이 새로 매수해 장부에 기록한 수량만 손절, 수익 추적 청산, 최대
보유기간 청산의 대상이 됩니다. 현재 정책 엔진은 PAPER 검증용이며 주문 API를
호출하지 않습니다.

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

바꾸기 전에 `npm run backtest`로 먼저 재십시오. 배경과 실측은
[`STRATEGY_REVIEW_2026-08-05.md`](STRATEGY_REVIEW_2026-08-05.md)에 있습니다.

기본값은 전략의 수익성을 보장하지 않습니다. PAPER 로그를 충분히 모아 기준 전략과
비교한 뒤 조정하기 위한 시작값입니다.

환율과 ETF 현재가의 Toss 응답 형식을 조회하려면 다음 진단을 실행합니다. 기본 후보는
실제 주문 대상이 아니라 API 연동 확인용이며 `.env`의 `ETF_WATCHLIST`로 바꿀 수 있습니다.

```bash
npm run market:check
```

## FRED 거시경제 지표 조회

[FRED API](https://fred.stlouisfed.org/docs/api/fred/)에서 무료 API 키를 발급받아
`.env`에 추가합니다. 키는 Git이나 로그에 남기지 마세요.

```dotenv
FRED_API_KEY="발급받은 API 키"
```

다음 명령은 연준 기준금리, 근원 PCE, 실업률, Sahm 지표, 장단기 금리차를 조회해
`RISK_ON`, `NEUTRAL`, `RISK_OFF` 상태와 실험용 목표 비중을 출력합니다.
`macro:status` 명령 자체는 조회와 출력만 수행합니다.

```bash
npm run macro:status
```

PAPER 실행기는 FRED 결과를 `data/macro-snapshot.json`에 6시간 캐시하고 목표 비중을
신규 매수에 반영합니다. `RISK_ON`은 IWM을 일부 포함하고, `NEUTRAL`은 VTI·SCHD와
현금 10%, `RISK_OFF`는 IWM을 제외하고 현금 40%를 목표로 합니다. 거시 신호만으로
즉시 매도하지는 않으며 기존 손절·추적청산 정책은 그대로 적용합니다. FRED와 캐시를
모두 사용할 수 없을 때는 기존 포지션의 청산 판단만 수행하고 신규 매수는 중단합니다.

## API 키 없는 공식 뉴스·전문가 의견 감성

Federal Reserve 공식 통화정책·연설 RSS와 GDELT DOC 2.0의 최근 경제뉴스를 병렬로
수집합니다. 선택한 Bluesky 공개 작성자 피드와 Substack·개인 블로그 RSS도 함께
수집할 수 있습니다. 모든 소스는 별도의 API 키가 필요하지 않습니다. 결과는
`data/free-news-cache.json`에 기본 15분간 저장하며, 일부 소스 장애는 격리하고 모든
소스가 실패하면 마지막 캐시를 `stale` 상태로 사용합니다. 캐시도 없으면 뉴스 계층을
제외하고 FRED·MACD 점수로 폴백합니다.

```dotenv
SENTIMENT_PROVIDER=local
SENTIMENT_SCORE_WEIGHT=2
NEWS_MAX_RECORDS=75
BLUESKY_AUTHORS=economist.example,analyst.bsky.social
OPINION_RSS_FEEDS=https://writer.substack.com/feed,https://example.com/rss.xml
OPINION_SCORE_WEIGHT=0.1
# 선택: 기본 경제뉴스 검색식을 바꿀 때만 설정
# NEWS_QUERY=("Federal Reserve" OR FOMC OR inflation OR recession)
```

`BLUESKY_AUTHORS`에는 `@` 없이 공개 계정 핸들을 적습니다. `OPINION_RSS_FEEDS`에는
작성자가 직접 공개한 RSS 주소만 등록합니다. Substack의 기본 피드 주소는
`https://발행물이름.substack.com/feed`입니다. 전문가 의견은 사실 보도와 분리해서
분석하며 기본적으로 공식 뉴스 대비 10%만 보조 반영합니다. 공식 뉴스가 하나도 없으면
전문가 의견 신뢰도 자체를 10%로 제한합니다.

`local` 분석기는 프로젝트 안에서 실행되는 단어·문맥·부정어 기반 점수기이므로
OpenAI나 Anthropic API를 호출하지 않고 자연어 분석 비용이 0원입니다. 반환값은
`sentiment_score`, `confidence`, `summary_reason`, `bullish_signals`,
`bearish_signals`의 고정 JSON 구조를 검증합니다. 뉴스 감성 기여도는
`sentiment_score × confidence × SENTIMENT_SCORE_WEIGHT`로 계산해 FRED 점수에 더합니다.

## MACD 시장가격 보조 신호

PAPER 실행기는 15분마다 조회한 ETF 현재가를 `data/macd-snapshot.json`에 누적하고,
종목별 12·26·9 MACD를 계산합니다. 최소 34개 표본이 쌓이기 전에는 준비 중으로 표시되며
FRED·감성 판정에 영향을 주지 않습니다. 준비가 끝나면 다음 공식으로 작은 확인 신호만
추가합니다.

```text
기본점수 = FRED 점수 + 감성 점수 × 감성 신뢰도 × 감성 가중치
최종점수 = 기본점수 + MACD 점수 × MACD 신뢰도 × MACD 가중치
```

기본 MACD 가중치는 `0`입니다. 즉 계산과 표시는 하되 **판단에는 쓰지 않습니다.**
예전 기본값 `0.15`의 실제 기여도는 +0.029였는데, 배분이 갈리는 지점이 ±1.5이므로
어떤 값이 나와도 결정을 바꿀 수 없는 크기였습니다. 백테스트에서도 0 / 0.15 / 0.5 / 1.0
사이에 일관된 차이가 나오지 않았습니다.

실데이터 백테스트에서 증분이 확인되면 그때 켜십시오.

```dotenv
MACD_SCORE_WEIGHT=0
```

실제 로컬 LLM을 쓰고 싶다면 Ollama 설치 및 모델 다운로드 후 아래처럼 바꿀 수 있습니다.
이 경우에도 외부 LLM API 요금은 없지만 로컬 CPU/GPU 자원을 사용합니다.

```dotenv
SENTIMENT_PROVIDER=ollama
OLLAMA_MODEL=qwen3:4b
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

감성 결과만 확인하는 진단 명령은 다음과 같습니다.

```bash
npm run sentiment:status
```

PAPER 장부를 최초 100,000원 상당의 USD로 한 번만 초기화하고 한 사이클 실행합니다.
첫 실행 시 하루 매수 한도 안에서만 가상 매수하며, 이후 실행은 같은 장부를 이어서
사용합니다.

```bash
npm run paper:run
npm run paper:status
```

`paper:run`은 뉴욕 현지시간 기준 평일 정규장(09:30~16:00)에만 토큰을 발급하고
시장을 조회합니다. `America/New_York` 시간대를 사용하므로 서머타임 전환은 자동으로
반영됩니다. 장외 시간에 수동 진단이 꼭 필요할 때만 다음 명령을 사용합니다.

```bash
npm run paper:run -- --force
```

Oracle에서 15분마다 자동 실행하려면 `deploy/`의 systemd 서비스와 타이머를
사용합니다. 서비스는 `data/`만 쓸 수 있고 `.env`는 읽기 전용으로 사용합니다.

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

## 개발 순서

1. **완료:** OAuth2 인증, 계좌 목록, 모든 계좌의 보유 주식 조회
2. **진행 중:** 포트폴리오 스냅샷 저장 및 수익률/집중도/환율 분석
3. AI 에이전트의 읽기 전용 분석 도구 연결
4. 투자 원칙, 최대 손실, 종목·금액 한도와 평가/백테스트
5. 주문 초안까지만 생성하는 승인형 에이전트
6. 충분한 검증 후에만 명시적 사용자 승인과 제한을 둔 주문 실행

토스증권 공식 문서: <https://developers.tossinvest.com/docs>
