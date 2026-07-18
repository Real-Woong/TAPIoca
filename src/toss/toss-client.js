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
