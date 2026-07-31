import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApiResponse, ApiResponseError } from "@/lib/api-response";

// Covers this feature's own spec: the production incident where Inventory
// Growth's "Start" button crashed with `Unexpected token '<', "<!DOCTYPE
// "... is not valid JSON` because the frontend called response.json()
// unconditionally while the actual response was Vercel's generic HTML
// /500 error page (a Playwright-import crash in @/lib/admin-scraper.ts —
// see next.config.ts's own comment). parseApiResponse is what replaced
// every such blind response.json() call.

function jsonResponse(status: number, statusText: string, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(status: number, statusText: string, html: string): Response {
  return new Response(html, {
    status,
    statusText,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("successful JSON response is parsed and returned as-is", async () => {
  const response = jsonResponse(200, "OK", { success: true, jobId: "abc-123", status: "queued" });
  const data = await parseApiResponse<{ success: boolean; jobId: string; status: string }>(response);
  assert.deepEqual(data, { success: true, jobId: "abc-123", status: "queued" });
});

test("a thrown server error with a JSON {error} body surfaces that exact message", async () => {
  const response = jsonResponse(500, "Internal Server Error", {
    error: "Failed to start inventory growth",
    code: "INVENTORY_GROWTH_START_FAILED",
    details: "SUPABASE_SERVICE_ROLE_KEY is not set",
  });

  await assert.rejects(() => parseApiResponse(response), (error: unknown) => {
    assert.ok(error instanceof ApiResponseError);
    assert.equal(error.message, "Failed to start inventory growth");
    return true;
  });
});

test("a non-OK, non-JSON (HTML) response never reaches JSON.parse and throws a clear, safe message instead", async () => {
  // The exact production shape: a 500 with Vercel's generic error page.
  const response = htmlResponse(500, "Internal Server Error", "<!DOCTYPE html><html id=\"__next_error__\">...");

  await assert.rejects(() => parseApiResponse(response), (error: unknown) => {
    assert.ok(error instanceof ApiResponseError);
    // Must mention the real status and a snippet of the actual body —
    // never a raw "Unexpected token '<'" SyntaxError.
    assert.match(error.message, /500/);
    assert.match(error.message, /<!DOCTYPE html>/);
    assert.doesNotMatch(error.message, /Unexpected token/i);
    return true;
  });
});

test("a successful (2xx) response that isn't JSON still throws clearly, rather than returning null silently", async () => {
  const response = htmlResponse(200, "OK", "<!DOCTYPE html><html>...");

  await assert.rejects(() => parseApiResponse(response), (error: unknown) => {
    assert.ok(error instanceof ApiResponseError);
    assert.match(error.message, /200/);
    assert.match(error.message, /content-type/i);
    return true;
  });
});

test("a response claiming application/json but with malformed JSON throws a clear parse error, not a raw SyntaxError", async () => {
  const response = new Response("{not valid json", {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(() => parseApiResponse(response), (error: unknown) => {
    assert.ok(error instanceof ApiResponseError);
    assert.match(error.message, /invalid JSON/i);
    assert.match(error.message, /200/);
    return true;
  });
});

test("a non-OK JSON response without a usable {error} string falls back to a status+body message", async () => {
  const response = jsonResponse(403, "Forbidden", { success: false });

  await assert.rejects(() => parseApiResponse(response), (error: unknown) => {
    assert.ok(error instanceof ApiResponseError);
    assert.match(error.message, /403/);
    assert.match(error.message, /Forbidden/);
    return true;
  });
});

test("an unauthenticated-style 401 JSON response (not an HTML redirect page) parses cleanly as the {error} it actually is", async () => {
  // Mirrors exactly what /api/admin-scraper/large-scale's own POST handler
  // returns for an unauthenticated/non-admin request — confirmed live
  // (see this task's own investigation) that this route never redirects
  // to an HTML /login page; it always returns this JSON shape directly.
  const response = jsonResponse(401, "Unauthorized", { success: false, error: "Not authorized.", code: "UNAUTHORIZED" });

  await assert.rejects(() => parseApiResponse(response), (error: unknown) => {
    assert.ok(error instanceof ApiResponseError);
    assert.equal(error.message, "Not authorized.");
    return true;
  });
});
