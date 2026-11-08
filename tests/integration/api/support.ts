/** What the route tests share: requests a browser would send, and reading a Set-Cookie back. */
const ORIGIN = "https://fairhold.example";

export function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** The name=value part of the response's session cookie, for the browser's next request. */
export function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("The response set no cookie");
  return header.split(";")[0] ?? "";
}

export const withCookie = (cookie: string, path = "/e") => new Request(`${ORIGIN}${path}`, { headers: { cookie } });
