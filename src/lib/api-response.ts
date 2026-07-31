// Safe fetch()-response parsing for client components calling this app's
// own API routes — added after a real production incident where the
// admin dashboard's "Start Inventory Growth" button crashed with
// `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`: the route
// crashed at the Next.js framework level (a Playwright import bundling
// issue — see next.config.ts's own comment) and Vercel served its
// generic static /500 HTML error page, which the frontend then blindly
// fed to response.json(). Never assume a response is JSON just because
// the request succeeded or the route is supposed to return JSON — a
// framework-level crash, a platform timeout, a stale/misconfigured
// domain redirect, or a proxy in front of the app can all substitute an
// HTML (or empty, or plain-text) body for the JSON this app's own route
// handlers always intend to send.
export class ApiResponseError extends Error {}

/**
 * Reads a fetch() Response exactly once (via .text(), never .json()
 * directly), then parses it as JSON only when the Content-Type header
 * actually claims to be JSON and a body is present. Throws a clear,
 * diagnosable ApiResponseError — including the HTTP status and the first
 * 300 characters of the raw body — instead of letting `Unexpected token
 * '<'...` (or any other JSON.parse crash) propagate from a mismatched
 * response. On a non-OK response, prefers a JSON `{ error }` field when
 * one was actually parsed, falling back to the same status+body-snippet
 * message otherwise.
 */
export async function parseApiResponse<T = unknown>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const rawBody = await response.text();

  let data: unknown = null;

  if (contentType.includes("application/json") && rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new ApiResponseError(
        `Server returned invalid JSON (${response.status}): ${rawBody.slice(0, 300)}`,
      );
    }
  }

  if (!response.ok) {
    const jsonMessage =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : null;

    throw new ApiResponseError(
      jsonMessage ??
        `Inventory Growth failed (${response.status} ${response.statusText}). ` +
          `Response: ${rawBody.slice(0, 300)}`,
    );
  }

  // A successful (2xx) response that still isn't JSON is just as much a
  // bug as a failed one silently swallowed — surface it with the same
  // amount of diagnostic detail rather than returning `null` and letting
  // a caller crash later on `data.jobId` or similar.
  if (!(contentType.includes("application/json") && rawBody)) {
    throw new ApiResponseError(
      `Expected a JSON response but got ${response.status} with content-type "${contentType || "none"}": ` +
        `${rawBody.slice(0, 300)}`,
    );
  }

  return data as T;
}
