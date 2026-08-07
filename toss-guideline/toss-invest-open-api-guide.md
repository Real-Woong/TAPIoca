# 토스증권 Open API 가이드

> 이 문서는 토스증권 Open API 가이드 내용을 Markdown 형식으로 정리한 문서입니다.
>
> 공식 문서: [developers.tossinvest.com/docs](https://developers.tossinvest.com/docs)

## 개요

토스증권 Open API는 다음 다섯 가지 카테고리로 구성됩니다.

1. **인증(Auth)** — OAuth 2.0 토큰 발급
2. **시세·종목 정보** — 시세, 종목 마스터, 환율, 장 운영 시간, 랭킹, 지수
3. **계좌·자산** — 계좌 목록 및 보유 주식 조회
4. **주문** — 주문 생성·정정·취소, 주문 조회, 거래 가능 정보
5. **조건주문** — 감시 조건 등록 시 자동 매매(SINGLE·OCO·OTO)

국내 및 미국 주식의 시세, 종목 정보, 환율, 장 운영 시간 등을 조회할 수 있고, 본인 계좌의 보유 주식과 주문·조건주문을 관리할 수 있습니다.

토스증권 Open API는 현재 REST API를 제공합니다.

## 인증

모든 API 호출에는 OAuth 2.0 액세스 토큰이 필요합니다. 토큰은 Client Credentials Grant 방식으로 발급합니다.

```text
POST /oauth2/token
```

계좌·자산, 주문, 조건주문 API는 액세스 토큰 외에 `X-Tossinvest-Account` 계좌 식별 헤더도 필요합니다.

## 기능 목록

### Auth — OAuth 2.0

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `POST` | `/oauth2/token` | OAuth 2.0 액세스 토큰 발급 |

### Market Data — 시세

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/orderbook` | 호가 조회 |
| `GET` | `/api/v1/prices` | 현재가 조회 |
| `GET` | `/api/v1/trades` | 최근 체결 내역 조회 |
| `GET` | `/api/v1/price-limits` | 상·하한가 조회 |
| `GET` | `/api/v1/candles` | 캔들 차트 조회(1분봉·일봉) |

### Stock Info — 종목 정보

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/stocks` | 종목 기본 정보 조회 |
| `GET` | `/api/v1/stocks/{symbol}/warnings` | 매수 유의사항 조회 |
| `GET` | `/api/v1/stocks/{symbol}/investor-trading` | 투자자별 매매동향 조회 |
| `GET` | `/api/v1/stocks/{symbol}/program-trades` | 프로그램매매 동향 조회 |
| `GET` | `/api/v1/stocks/{symbol}/short-selling` | 공매도 동향 조회 |
| `GET` | `/api/v1/stocks/{symbol}/credit-trades` | 신용거래 동향 조회 |
| `GET` | `/api/v1/stocks/{symbol}/securities-lending` | 대차거래 동향 조회 |

### Market Info — 환율·장 운영 시간

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/exchange-rate` | KRW↔USD 환율 조회 |
| `GET` | `/api/v1/market-calendar/KR` | 국내 장 운영 정보(KRX·NXT) |
| `GET` | `/api/v1/market-calendar/US` | 미국 장 운영 정보(데이마켓·프리·정규·애프터) |

### Ranking — 주식 랭킹

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/rankings` | 거래대금·거래량·등락률 랭킹 조회 |

### Market Indicators — 시장 지표

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/market-indicators/prices` | 시장 지표 현재가 조회 |
| `GET` | `/api/v1/market-indicators/{symbol}/candles` | 시장 지표 캔들 조회 |
| `GET` | `/api/v1/market-indicators/{symbol}/investor-trading` | 투자자별 매매대금 조회 |

### Account — 계좌

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/accounts` | 계좌 목록 조회 |

### Asset — 보유 자산

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/holdings` | 보유 주식 조회 |

### Order — 주문

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `POST` | `/api/v1/orders` | 주문 생성(지정가·시장가 / KR·US) |
| `POST` | `/api/v1/orders/{orderId}/modify` | 주문 정정(가격·수량) |
| `POST` | `/api/v1/orders/{orderId}/cancel` | 주문 취소 |

### Order History — 주문 조회

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/orders` | 주문 목록 조회(대기중·종료) |
| `GET` | `/api/v1/orders/{orderId}` | 주문 상세 조회(모든 상태) |

### Order Info — 거래 가능 정보

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/buying-power` | 매수 가능 금액 조회 |
| `GET` | `/api/v1/sellable-quantity` | 판매 가능 수량 조회 |
| `GET` | `/api/v1/commissions` | 매매 수수료 조회 |

### Conditional Order — 조건주문

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `POST` | `/api/v1/conditional-orders` | 조건주문 등록(SINGLE·OCO·OTO) |
| `POST` | `/api/v1/conditional-orders/{conditionalOrderId}/modify` | 조건주문 수정 |
| `DELETE` | `/api/v1/conditional-orders/{conditionalOrderId}` | 조건주문 취소 |

조건주문은 지정한 가격에 도달하면 자동으로 매수·매도 주문을 생성합니다. 호가 유형은 지정가(`LIMIT`)와 시장가(`MARKET`)입니다.

### Conditional Order History — 조건주문 조회

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/v1/conditional-orders` | 조건주문 목록 조회(진행 중 `OPEN`·종료 `CLOSED`) |
| `GET` | `/api/v1/conditional-orders/{conditionalOrderId}` | 조건주문 상세 조회 |

## 시작하기

1. 토스증권 WTS에 로그인합니다.
2. `설정 → Open API`에서 `client_id`와 `client_secret`을 발급받습니다.
3. 같은 메뉴의 허용 IP 관리에서 API 호출을 허용할 IP를 등록합니다.
4. `/oauth2/token`으로 액세스 토큰을 발급받습니다.
5. 모든 요청에 `Authorization: Bearer {access_token}`을 전달합니다.
6. 계좌·자산·주문·조건주문 요청에는 `X-Tossinvest-Account: {accountSeq}`도 전달합니다.

### 토큰 발급

```bash
curl -s -X POST 'https://openapi.tossinvest.com/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials' \
  -d 'client_id=xxx' \
  -d 'client_secret=yyy'
```

### 시세·종목 정보 조회

```bash
curl -s 'https://openapi.tossinvest.com/api/v1/stocks?symbols=005930' \
  -H 'Authorization: Bearer eyJhbGciOi...'
```

### 계좌·자산·주문 API 호출

```bash
curl -s 'https://openapi.tossinvest.com/api/v1/holdings' \
  -H 'Authorization: Bearer eyJhbGciOi...' \
  -H 'X-Tossinvest-Account: 1'
```

## Rate Limits

요청 제한은 클라이언트와 API 그룹별 초당 요청 수(TPS)로 적용됩니다. 운영 중 변경될 수 있으므로 실제 기준은 응답 헤더의 `X-RateLimit-Limit`을 사용합니다.

| Rate Limits Group | 기본 요청 한도 | 피크시간 한도 |
|---|---:|---:|
| `AUTH` | 초당 5회 | — |
| `ACCOUNT` | 초당 1회 | — |
| `ASSET` | 초당 5회 | — |
| `STOCK` | 초당 5회 | — |
| `STOCK_TRADING_TREND` | 초당 10회 | — |
| `MARKET_INFO` | 초당 3회 | — |
| `MARKET_DATA` | 초당 10회 | — |
| `MARKET_DATA_CHART` | 초당 5회 | — |
| `RANKING` | 초당 5회 | — |
| `MARKET_INDICATOR_PRICE` | 초당 10회 | — |
| `MARKET_INDICATOR` | 초당 10회 | — |
| `MARKET_INDICATOR_CHART` | 초당 5회 | — |
| `ORDER` | 초당 10회 | 09:00~09:10 KST: 초당 10회 |
| `ORDER_HISTORY` | 초당 5회 | — |
| `ORDER_INFO` | 초당 6회 | 09:00~09:10 KST: 초당 3회 |
| `CONDITIONAL_ORDER` | 초당 5회 | — |
| `CONDITIONAL_ORDER_HISTORY` | 초당 10회 | — |

### Rate Limit 응답 헤더

| 헤더 | 의미 |
|---|---|
| `X-RateLimit-Limit` | 현재 허용된 초당 요청 수 |
| `X-RateLimit-Remaining` | 남은 요청 토큰 수 |
| `X-RateLimit-Reset` | 토큰 1개 재충전까지 예상 시간 |
| `Retry-After` | 429 응답 시 재시도 권장 시간 |

### 429 대응

- `429`를 받으면 `Retry-After`만큼 기다립니다.
- 지수 백오프(`1s → 2s → 4s ...`)와 jitter를 함께 사용합니다.
- `X-RateLimit-Remaining`이 낮으면 요청 속도를 선제적으로 낮춥니다.

## 에러 응답

모든 일반 API 오류는 다음 형태의 envelope으로 반환됩니다.

```json
{
  "error": {
    "requestId": "01HXYZABCDEFG123456789",
    "code": "invalid-request",
    "message": "주문 방향이 올바르지 않습니다.",
    "data": {
      "field": "side",
      "allowedValues": ["BUY", "SELL"]
    }
  }
}
```

- `requestId`: 요청 추적번호. 응답 헤더 `X-Request-Id`와 동일합니다.
- `code`: 기계적으로 분류할 오류 코드입니다.
- `message`: 오류 설명입니다.
- `data`: 필드명, 허용값, 재시도 시각 등 추가 정보입니다.

일부 응답에서 `requestId`가 누락되면 응답 헤더의 `referenceId` 또는 `x-amz-cf-id`를 확인합니다.

## 오류 코드 목록

| HTTP 상태 | 코드 | 설명 |
|---:|---|---|
| 400 | `invalid-request` | 필수 파라미터, 호가 유형, 주문 방향, 수량·금액 등이 잘못됨 |
| 400 | `confirm-high-value-required` | 1억원 이상 주문에서 확인 플래그 누락 |
| 400 | `account-header-required` | `X-Tossinvest-Account` 헤더 누락 |
| 400 | `unsupported-ranking-duration` | 일부 랭킹에서 지원하지 않는 기간 요청 |
| 400 | `unsupported-symbol` | 지원하지 않는 심볼 |
| 400 | `unsupported-market` | 국내 전용 API에 해외 종목 요청 |
| 401 | `invalid-token` | 토큰이 유효하지 않음 |
| 401 | `edge-blocked` | `Authorization` 헤더 누락 |
| 401 | `expired-token` | 액세스 토큰 만료 |
| 401 | `login-user-not-found` | 토큰에 대응하는 로그인 정보 없음 |
| 403 | `forbidden` | 필요한 권한 부족 |
| 404 | `edge-blocked` | 지원하지 않는 API 경로 |
| 404 | `stock-not-found` | 종목을 찾을 수 없음 |
| 404 | `exchange-rate-not-found` | 환율 정보를 찾을 수 없음 |
| 404 | `account-not-found` | 계좌를 찾을 수 없음 |
| 404 | `order-not-found` | 주문을 찾을 수 없음 |
| 404 | `conditional-order-not-found` | 조건주문을 찾을 수 없음 |
| 409 | `request-in-progress` | 동일 `clientOrderId` 요청 처리 중 |
| 409 | `already-filled` | 이미 체결된 주문 |
| 409 | `already-canceled` | 이미 취소된 주문 |
| 409 | `already-modified` | 이미 정정된 주문 |
| 409 | `already-rejected` | 이미 거부된 주문 |
| 409 | `already-processing` | 동일 주문의 정정·취소 처리 중 |
| 415 | `unsupported-content-type` | `Content-Type`이 `application/json`이 아님 |
| 422 | `insufficient-buying-power` | 주문 가능 금액 부족 |
| 422 | `order-hours-closed` | 주문 접수 가능 시간이 아님 |
| 422 | `stock-restricted` | 거래 제한 종목 |
| 422 | `price-out-of-range` | 가격이 허용 범위를 벗어남 |
| 422 | `opposite-pending-order-exists` | 같은 종목의 반대 방향 미체결 주문 존재 |
| 422 | `order-type-not-allowed` | 현재 사용할 수 없는 호가 유형 |
| 422 | `prerequisite-required` | 약관·교육·위험고지 등 사전 요건 미충족 |
| 422 | `market-not-supported-for-stock` | 종목과 시장 조합이 거래 불가 |
| 422 | `investor-exchange-not-integrated` | 투자자지시 거래소가 통합(SOR)이 아님 |
| 422 | `amount-order-outside-regular-hours` | 미국 금액 주문 가능 시간이 아님 |
| 422 | `modify-restricted` | 주문 정정 제한 |
| 422 | `cancel-restricted` | 주문 취소 제한 |
| 422 | `insufficient-sellable-quantity` | 매도 가능 수량 부족 |
| 422 | `order-limit-exceeded` | 주문 설정 한도 초과 |
| 422 | `duplicate-conditional-order` | 중복 조건주문 |
| 422 | `condition-already-met` | 조건이 이미 충족됨 |
| 422 | `idempotency-key-conflict` | 같은 `clientOrderId`로 다른 내용 재요청 |
| 422 | `account-restricted` | 계좌 상태가 주문을 허용하지 않음 |
| 429 | `edge-rate-limit-exceeded` | 엣지 요청 제한 초과 |
| 429 | `rate-limit-exceeded` | API 요청 제한 초과 |
| 500 | `internal-error` | 서버 내부 오류 |
| 500 | `maintenance` | 시스템 점검 중 |

