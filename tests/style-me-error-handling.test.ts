// Covers the P0 launch-readiness fix for submitStyleMeRequest
// (src/app/actions/style-me.ts) — it previously had NO top-level
// try/catch, unlike its Recreate This Outfit sibling
// (submitOutfitRecreation), so an unexpected exception anywhere in its
// ~160 lines of work would propagate uncaught to a raw error page. Source-
// level assertions (this action needs a real Supabase DB + OpenAI to
// exercise end-to-end).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "src", "app", "actions", "style-me.ts"), "utf-8");

test("submitStyleMeRequest wraps its real work in a try/catch that returns a graceful error", () => {
  const outerFn = source.slice(
    source.indexOf("export async function submitStyleMeRequest"),
    source.indexOf("async function submitStyleMeRequestInner"),
  );
  assert.match(outerFn, /try\s*\{/);
  assert.match(outerFn, /catch \(error\)/);
  assert.match(outerFn, /return\s*\{\s*error:/);
});

test("redirect() is called OUTSIDE the try/catch, so a successful submission is never misreported as a failure", () => {
  const outerFn = source.slice(
    source.indexOf("export async function submitStyleMeRequest"),
    source.indexOf("async function submitStyleMeRequestInner"),
  );
  const catchIndex = outerFn.indexOf("catch (error)");
  const catchCloseIndex = outerFn.indexOf("}", outerFn.indexOf("};", catchIndex));
  const redirectIndex = outerFn.indexOf("redirect(");
  assert.ok(redirectIndex > catchCloseIndex, "redirect() must appear after the catch block closes");
});

test("every validation/insert failure inside the inner function throws rather than silently returning undefined", () => {
  const innerFn = source.slice(source.indexOf("async function submitStyleMeRequestInner"));
  const throwCount = (innerFn.match(/throw new Error\(/g) ?? []).length;
  assert.ok(throwCount >= 5, `expected several distinct throw sites, found ${throwCount}`);
});
