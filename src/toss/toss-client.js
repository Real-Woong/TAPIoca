const DEFAULT_BASE_URL = "https://openapi.tossinvest.com";
const DEFAULT_TIMEOUT_MS = 15_000;

// Toss Open API에서 받은 오류 정보를 잃지 않고 CLI까지 전달하기 위한 전용 오류입니다.
// requestId는 장애 문의나 서버 로그 추적에 사용할 수 있습니다.
export class TossApiError extends Error {
  constructor(message, { status, code, requestId, details } = {}) {
    super(message);
    this.name = "TossApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export class TossInvestClient {
  // 인증정보와 토큰은 외부에서 직접 읽거나 바꾸지 못하도록 private 필드로 보관합니다.
  #clientId;
  #clientSecret;
  #baseUrl;
  #fetch;
  #timeoutMs;
  #token;
  #tokenPromise;
  #tokenExpiresAt = 0;

  constructor({
    clientId,
    clientSecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    if (!clientId || !clientSecret) {
      throw new Error("TOSS_CLIENT_ID와 TOSS_CLIENT_SECRET이 필요합니다.");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch 구현이 필요합니다.");
    }

    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async issueAccessToken() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
    });

    const response = await this.#request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      authenticated: false,
    });

    if (!response.access_token || !response.expires_in) {
      throw new TossApiError("토큰 응답 형식이 올바르지 않습니다.", {
        details: response,
      });
    }

    this.#token = response.access_token;
    // 만료 직전 동시 요청을 피하기 위한 60초 여유입니다.
    this.#tokenExpiresAt = Date.now() + Math.max(0, response.expires_in - 60) * 1000;
    return response.access_token;
  }

  async getAccounts() {
    const response = await this.#request("/api/v1/accounts");
    return response.result ?? [];
  }

  async getHoldings(accountSeq, { symbol } = {}) {
    if (!Number.isInteger(accountSeq) || accountSeq < 1) {
      throw new Error("accountSeq는 1 이상의 정수여야 합니다.");
    }

    const query = new URLSearchParams();
    if (symbol) query.set("symbol", symbol);
    const suffix = query.size ? `?${query}` : "";

    const response = await this.#request(`/api/v1/holdings${suffix}`, {
      headers: { "X-Tossinvest-Account": String(accountSeq) },
    });
    return response.result;
  }

  async getPrices(symbols) {
    const symbolList = Array.isArray(symbols) ? symbols : [symbols];
    const normalized = symbolList.map((symbol) => String(symbol).trim()).filter(Boolean);
    if (normalized.length === 0) throw new Error("현재가를 조회할 종목이 필요합니다.");

    // 현재가 API는 종목별 단일 요청 형식을 사용하므로 각 종목을 따로 조회합니다.
    return Promise.all(normalized.map((symbol) => this.getPrice(symbol)));
  }

  async getPrice(symbol) {
    const normalized = String(symbol ?? "").trim();
    if (!normalized) throw new Error("현재가를 조회할 종목이 필요합니다.");
    const query = new URLSearchParams({ symbols: normalized });
    const response = await this.#request(`/api/v1/prices?${query}`);
    return response?.result ?? response;
  }

  async getExchangeRate(baseCurrency = "USD", quoteCurrency = "KRW") {
    const normalizedBase = String(baseCurrency ?? "").trim().toUpperCase();
    const normalizedQuote = String(quoteCurrency ?? "").trim().toUpperCase();
    if (!normalizedBase) throw new Error("환율 기준통화가 필요합니다.");
    if (!normalizedQuote) throw new Error("환율 상대통화가 필요합니다.");
    const query = new URLSearchParams({
      baseCurrency: normalizedBase,
      quoteCurrency: normalizedQuote,
    });
    const response = await this.#request(`/api/v1/exchange-rate?${query}`);
    return response?.result ?? response;
  }

  /**
   * 유효한 액세스 토큰을 돌려줍니다. 만료가 가까우면 알아서 재발급합니다.
   *
   * 실주문 어댑터(`src/live/toss-broker.js`)가 이것을 물어 씁니다. 어댑터가
   * 토큰 문자열을 들고 있으면 만료에 걸리므로, **매 호출마다 여기에 물어보게**
   * 해서 갱신 관리를 한 곳에만 둡니다.
   */
  async getAccessToken() {
    return this.#getValidToken();
  }

  /**
   * 호가입니다. **슬리피지의 기준선**이 여기서 나옵니다.
   *
   * 시장가 주문은 체결가를 우리가 정하지 못하므로, 주문 직전 중간가와 실제
   * 체결가의 차이가 곧 우리가 치른 비용입니다. 그 기준선을 주문 전에 찍어
   * 두지 않으면 나중에 되살릴 방법이 없습니다.
   */
  async getOrderbook(symbol) {
    const normalized = String(symbol ?? "").trim();
    if (!normalized) throw new Error("호가를 조회할 종목이 필요합니다.");

    // 파라미터 이름을 문서에서 확인하지 못했습니다. `symbols`로 보냈더니
    // `invalid-request`가 났으므로(2026-08-07) 단수형을 먼저 시도하고, 실패하면
    // 복수형으로 한 번 더 갑니다. **둘 다 실패하면 마지막 오류를 그대로 던져**
    // 어느 필드가 문제인지 호출부가 볼 수 있게 합니다.
    let lastError = null;
    for (const parameter of ["symbol", "symbols"]) {
      try {
        const query = new URLSearchParams({ [parameter]: normalized });
        const response = await this.#request(`/api/v1/orderbook?${query}`);
        return response?.result ?? response;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** 미국 장 운영 정보입니다. 조기 폐장일 판단에 씁니다. */
  async getUsMarketCalendar() {
    const response = await this.#request("/api/v1/market-calendar/US");
    return response?.result ?? response;
  }

  /** 매매 수수료입니다. 백테스트의 10bp 가정을 주문 전에 대조할 수 있습니다. */
  async getCommissions(accountSeq, { symbol } = {}) {
    const query = new URLSearchParams();
    if (symbol) query.set("symbol", symbol);
    const suffix = query.size ? `?${query}` : "";
    const response = await this.#request(`/api/v1/commissions${suffix}`, {
      headers: { "X-Tossinvest-Account": String(accountSeq) },
    });
    return response?.result ?? response;
  }

  /** 매수 가능 금액입니다. 낼 수 있는 주문인지 미리 봅니다. */
  async getBuyingPower(accountSeq, { symbol, currency } = {}) {
    const query = new URLSearchParams();
    if (symbol) query.set("symbol", symbol);
    if (currency) query.set("currency", currency);
    const suffix = query.size ? `?${query}` : "";
    const response = await this.#request(`/api/v1/buying-power${suffix}`, {
      headers: { "X-Tossinvest-Account": String(accountSeq) },
    });
    return response?.result ?? response;
  }

  async getPortfolio({ symbol } = {}) {
    // 계좌 목록을 먼저 받은 뒤 각 accountSeq를 헤더에 넣어 보유 종목을 조회합니다.
    const accounts = await this.getAccounts();
    const portfolioAccounts = await Promise.all(
      accounts.map(async (account) => ({
        ...account,
        holdings: await this.getHoldings(account.accountSeq, { symbol }),
      })),
    );

    return {
      fetchedAt: new Date().toISOString(),
      accounts: portfolioAccounts,
    };
  }

  async #getValidToken() {
    // 유효한 토큰은 재사용합니다. 동시에 여러 요청이 들어와도 tokenPromise 하나를
    // 공유하므로 같은 순간에 토큰을 여러 번 발급하지 않습니다.
    if (this.#token && Date.now() < this.#tokenExpiresAt) return this.#token;
    if (!this.#tokenPromise) {
      this.#tokenPromise = this.issueAccessToken().finally(() => {
        this.#tokenPromise = undefined;
      });
    }
    return this.#tokenPromise;
  }

  async #request(path, options = {}) {
    // 모든 API 호출이 인증, 타임아웃, JSON 파싱, 오류 변환을 같은 방식으로 거칩니다.
    const { authenticated = true, headers = {}, ...requestOptions } = options;
    const requestHeaders = { accept: "application/json", ...headers };

    if (authenticated) {
      requestHeaders.authorization = `Bearer ${await this.#getValidToken()}`;
    }

    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...requestOptions,
        headers: requestHeaders,
        signal: requestOptions.signal ?? AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new TossApiError(`토스 API 요청이 ${this.#timeoutMs}ms 안에 완료되지 않았습니다.`);
      }
      throw new TossApiError(`토스 API에 연결하지 못했습니다: ${error.message}`);
    }

    const payload = await parseResponse(response);
    if (!response.ok) {
      const apiError = payload?.error;
      const code = typeof apiError === "string" ? apiError : apiError?.code;
      const message =
        (typeof apiError === "object" && apiError?.message) ||
        payload?.error_description ||
        `토스 API 요청이 실패했습니다. (HTTP ${response.status})`;

      throw new TossApiError(message, {
        status: response.status,
        code,
        requestId: apiError?.requestId,
        details: payload,
      });
    }

    return payload;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new TossApiError("토스 API가 JSON이 아닌 응답을 반환했습니다.", {
      status: response.status,
    });
  }
}

export function createTossClientFromEnv(env = process.env, options = {}) {
  // 비밀값은 코드에 적지 않고 실행 시 .env를 통해서만 전달합니다.
  return new TossInvestClient({
    clientId: env.TOSS_CLIENT_ID,
    clientSecret: env.TOSS_CLIENT_SECRET,
    baseUrl: env.TOSS_API_BASE_URL || DEFAULT_BASE_URL,
    ...options,
  });
}
