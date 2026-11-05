/**
 * A wire-level PayPal stand-in for the sandbox client: it sees exactly the HTTP requests the SDK
 * and the direct REST calls build, and answers with canned PayPal responses.
 */
import type { PaypalHttpAdapter, PaypalHttpRequest, PaypalHttpResponse } from "@/server/paypal/sandbox-client";

type Responder = (request: PaypalHttpRequest) => PaypalHttpResponse | Promise<PaypalHttpResponse>;

interface Route {
  method: string;
  path: string;
  respond: Responder;
}

export const TOKEN_LIFETIME_SECONDS = 32_400;

export class FakePaypal {
  readonly requests: PaypalHttpRequest[] = [];
  tokensIssued = 0;
  private readonly routes: Route[] = [];

  constructor() {
    this.on("POST", "/v1/oauth2/token", () => {
      this.tokensIssued += 1;
      return json(200, {
        access_token: `token-${this.tokensIssued}`,
        token_type: "Bearer",
        expires_in: TOKEN_LIFETIME_SECONDS,
        scope: "https://uri.paypal.com/services/payments/payment",
      });
    });
  }

  /** The newest matching route answers, so a test can override a default. */
  on(method: string, path: string, respond: Responder): this {
    this.routes.unshift({ method, path, respond });
    return this;
  }

  readonly http: PaypalHttpAdapter = async (request) => {
    this.requests.push(request);
    const { pathname } = new URL(request.url);
    const route = this.routes.find((candidate) => candidate.method === request.method && candidate.path === pathname);
    if (!route) return paypalError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "debug-no-route");
    return route.respond(request);
  };

  /** Requests other than token requests. */
  apiRequests(): PaypalHttpRequest[] {
    return this.requests.filter((request) => !request.url.endsWith("/v1/oauth2/token"));
  }

  lastRequest(path: string): PaypalHttpRequest {
    const match = this.requests.filter((request) => new URL(request.url).pathname === path).at(-1);
    if (!match) throw new Error(`no request to ${path}`);
    return match;
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): PaypalHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": `debug-${status}`, ...headers },
    body: JSON.stringify(body),
  };
}

export function empty(status: number): PaypalHttpResponse {
  return { status, headers: { "paypal-debug-id": `debug-${status}` }, body: "" };
}

/** PayPal's error shape: a name, a message, a debug_id and the specific issue in details. */
export function paypalError(status: number, name: string, issue: string | null, debugId: string): PaypalHttpResponse {
  return json(
    status,
    {
      name,
      message: "The requested action could not be performed.",
      debug_id: debugId,
      ...(issue ? { details: [{ issue, description: `${issue} description` }] } : {}),
      links: [],
    },
    { "paypal-debug-id": debugId },
  );
}

export function bodyOf(request: PaypalHttpRequest): unknown {
  return request.body === undefined ? undefined : JSON.parse(request.body);
}

/** An authorization as PayPal returns it in an authorize, reauthorize or GET response. */
export function authorizationBody(id: string, status: string, value: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status,
    amount: { currency_code: "USD", value },
    custom_id: "hold-1",
    expiration_time: "2026-12-03T21:00:00Z",
    create_time: "2026-11-04T21:00:00Z",
    update_time: "2026-11-04T21:00:00Z",
    links: [],
    ...extra,
  };
}
