/**
 * The PayPal sandbox connection: one @paypal/paypal-server-sdk client, one client-credentials
 * token cached until shortly before it expires, and direct REST calls for what the SDK lacks
 * (webhook signature verification). Every failure leaves as a PaypalError.
 */
import {
  ApiError,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  ResponseValidationError,
  type ApiResponse,
  type OAuthToken,
} from "@paypal/paypal-server-sdk";

import {
  PaypalError,
  paypalErrorFromException,
  paypalErrorFromResponse,
  unexpectedResponse,
  type PaymentsOperation,
} from "./errors";

export const SANDBOX_API_BASE_URL = "https://api-m.sandbox.paypal.com";

export interface PaypalHttpRequest {
  method: string;
  url: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: string | undefined;
}

export interface PaypalHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Stands in for the network under both the SDK and the direct REST calls; tests fake PayPal here. */
export type PaypalHttpAdapter = (request: PaypalHttpRequest) => Promise<PaypalHttpResponse>;

export interface PaypalSandboxClientOptions {
  clientId: string;
  clientSecret: string;
  /** Per request. The SDK's own default is 0, which waits forever. */
  timeoutMs?: number;
  http?: PaypalHttpAdapter;
}

export interface SdkControllers {
  orders: OrdersController;
  payments: PaymentsController;
}

/** The SDK asks for a new token once its copy is within this many seconds of expiry. */
const SDK_CLOCK_SKEW_SECONDS = 60;
/**
 * The cache renews earlier than that, so whenever the SDK asks, it gets a token it will accept;
 * a token handed over as fresh is never one the SDK would itself call expired.
 */
const TOKEN_REFRESH_MARGIN_SECONDS = 120;
const DEFAULT_TIMEOUT_MS = 30_000;

interface SdkInstance extends SdkControllers {
  client: Client;
}

export class PaypalSandboxClient {
  readonly baseUrl = SANDBOX_API_BASE_URL;
  private readonly timeoutMs: number;
  private sdk: SdkInstance | undefined;
  private token: OAuthToken | undefined;
  private pendingToken: Promise<OAuthToken> | undefined;

  constructor(private readonly options: PaypalSandboxClientOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new Error("The PayPal sandbox client needs a client id and secret");
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Runs one SDK call and maps any failure to a PaypalError for `operation`. */
  async call<T>(
    operation: PaymentsOperation,
    run: (sdk: SdkControllers) => Promise<ApiResponse<T>>,
  ): Promise<ApiResponse<T>> {
    try {
      return await run(this.instance());
    } catch (error) {
      throw this.toFailure(operation, error);
    }
  }

  /** A JSON POST outside the SDK, authenticated with the shared token. */
  async postJson(
    operation: PaymentsOperation,
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<PaypalHttpResponse> {
    const accessToken = await this.accessToken();
    let response: PaypalHttpResponse;
    try {
      response = await this.send({
        method: "POST",
        url: `${this.baseUrl}${path}`,
        headers: {
          ...lowerCaseKeys(headers),
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body,
      });
    } catch (error) {
      throw paypalErrorFromException(operation, error);
    }
    if (response.status < 200 || response.status > 299) {
      throw this.toFailure(operation, paypalErrorFromResponse(operation, response));
    }
    return response;
  }

  async accessToken(): Promise<string> {
    return (await this.oauthToken()).accessToken;
  }

  private oauthToken(): Promise<OAuthToken> {
    if (this.token && isFresh(this.token)) return Promise.resolve(this.token);
    // Concurrent callers share one token request.
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<OAuthToken> {
    try {
      const token = await this.instance().client.clientCredentialsAuthManager.fetchToken();
      this.token = token;
      return token;
    } catch (error) {
      throw this.toFailure("authenticate", error);
    }
  }

  private instance(): SdkInstance {
    if (this.sdk) return this.sdk;
    const client = new Client({
      environment: Environment.Sandbox,
      timeout: this.timeoutMs,
      clientCredentialsAuthCredentials: {
        oAuthClientId: this.options.clientId,
        oAuthClientSecret: this.options.clientSecret,
        oAuthClockSkew: SDK_CLOCK_SKEW_SECONDS,
        oAuthTokenProvider: () => this.oauthToken(),
      },
      unstable_httpClientOptions: axiosOverrides(this.options.http),
    });
    this.sdk = { client, orders: new OrdersController(client), payments: new PaymentsController(client) };
    return this.sdk;
  }

  private toFailure(operation: PaymentsOperation, error: unknown): PaypalError {
    const failure = mapSdkError(operation, error);
    if (failure.operation === "authenticate" || failure.httpStatus === 401) {
      // The SDK keeps its token in a promise shared by every call: once a token request fails,
      // that promise stays rejected for the life of the client, and a 401 means PayPal no longer
      // accepts the token. Either way the next call starts with a new client and a new token.
      this.token = undefined;
      this.sdk = undefined;
    }
    return failure;
  }

  private async send(request: PaypalHttpRequest): Promise<PaypalHttpResponse> {
    if (this.options.http) return this.options.http(request);
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }
}

function mapSdkError(operation: PaymentsOperation, error: unknown): PaypalError {
  if (error instanceof PaypalError) return error;
  if (error instanceof ResponseValidationError) {
    return unexpectedResponse(operation, error.message.split("\n")[0] ?? "schema mismatch");
  }
  if (error instanceof ApiError) {
    // Statuses the SDK declares come with `result` parsed; the others only carry the raw body.
    return paypalErrorFromResponse(
      operation,
      { status: error.statusCode, headers: error.headers, body: error.result ?? error.body },
      error,
    );
  }
  return paypalErrorFromException(operation, error);
}

/** `expiry` is Unix seconds, set by the SDK from expires_in when it fetched the token. */
function isFresh(token: OAuthToken): boolean {
  if (token.expiry === undefined) return true;
  return Number(token.expiry) - TOKEN_REFRESH_MARGIN_SECONDS >= Date.now() / 1000;
}

interface AxiosRequestShape {
  method?: string;
  url?: string;
  headers?: unknown;
  data?: unknown;
}

/** Overrides for the SDK's internal Axios instance (`unstable_httpClientOptions`). */
function axiosOverrides(http: PaypalHttpAdapter | undefined): Record<string, unknown> {
  return {
    // Axios labels a POST without a body as a form post. Void is the only such call, and PayPal
    // documents it with Content-Type application/json.
    headers: { post: { "Content-Type": "application/json" } },
    ...(http ? { adapter: toAxiosAdapter(http) } : {}),
  };
}

function toAxiosAdapter(http: PaypalHttpAdapter) {
  return async (config: AxiosRequestShape) => {
    const response = await http({
      method: (config.method ?? "get").toUpperCase(),
      url: config.url ?? "",
      headers: plainHeaders(config.headers),
      body: typeof config.data === "string" ? config.data : undefined,
    });
    return {
      data: response.body,
      status: response.status,
      statusText: String(response.status),
      headers: lowerCaseKeys(response.headers),
      config,
      request: {},
    };
  };
}

function plainHeaders(headers: unknown): Record<string, string> {
  const source =
    headers && typeof (headers as { toJSON?: unknown }).toJSON === "function"
      ? (headers as { toJSON(): Record<string, unknown> }).toJSON()
      : ((headers as Record<string, unknown> | undefined) ?? {});
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && value !== null && value !== false) result[name.toLowerCase()] = String(value);
  }
  return result;
}

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}
