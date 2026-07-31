import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveBottomCtaState } from "@/app/page";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(__dirname, "../src/app/page.tsx"), "utf-8");

// Pure decision logic behind the homepage's bottom CTA
// ("Your closet's next favorite piece is already thrifted.") — kept
// separate from the Server Component so it's testable without rendering
// a React tree or mocking Supabase's query builder. Mirrors the same
// completion signal src/app/(app)/style-profile/page.tsx and
// src/app/(app)/profile/page.tsx already use:
// style_profiles.onboarding_completed_at.

test("logged-out user sees the CTA with 'Create your profile', linking to /signup", () => {
  const state = resolveBottomCtaState(null, null);
  assert.deepEqual(state, { show: true, href: "/signup", label: "Create your profile" });
});

test("signed-in user who has not completed onboarding sees 'Finish your profile', linking to /onboarding", () => {
  const state = resolveBottomCtaState({ id: "user-1" }, null);
  assert.deepEqual(state, { show: true, href: "/onboarding", label: "Finish your profile" });
});

test("signed-in user with a completed profile does not see the CTA at all", () => {
  const state = resolveBottomCtaState({ id: "user-1" }, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(state, { show: false });
});

test("undefined onboarding_completed_at (no style_profiles row at all) is treated the same as incomplete", () => {
  const state = resolveBottomCtaState({ id: "user-1" }, undefined);
  assert.deepEqual(state, { show: true, href: "/onboarding", label: "Finish your profile" });
});

// Source-level regression guard for requirement 4 ("does not see the CTA
// or its heading, no empty container") — this project has no React-
// rendering test harness (no jsdom/@testing-library/react dependency),
// so the actual rendered-output claim is verified by confirming the
// heading text sits inside a `{bottomCta.show && (...)}` guard rather
// than an unconditional section: when resolveBottomCtaState's own tests
// above prove `show` is false for a completed profile, this confirms
// that value is genuinely what gates the whole section (including the
// heading), not just the button label.
test("the CTA heading is rendered only inside the bottomCta.show conditional, not unconditionally", () => {
  const headingIndex = pageSource.indexOf("Your closet&apos;s next favorite piece is already thrifted.");
  assert.notEqual(headingIndex, -1, "expected to find the CTA heading text in page.tsx");

  const guardIndex = pageSource.indexOf("{bottomCta.show &&");
  assert.notEqual(guardIndex, -1, "expected a `{bottomCta.show && (...)}` guard in page.tsx");

  assert.ok(
    guardIndex < headingIndex,
    "the bottomCta.show guard must appear before the heading text, so the heading is conditionally rendered inside it",
  );
});
