// Covers three P0 launch-readiness fixes found during the likes/profile
// audit. Source-level assertions — each of these needs a real Supabase
// session/table to exercise end-to-end (RLS-gated Server Actions), which
// this project avoids depending on in its automated suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const savedItemsSource = readFileSync(join(__dirname, "..", "src", "app", "actions", "saved-items.ts"), "utf-8");
const saveButtonSource = readFileSync(join(__dirname, "..", "src", "components", "SaveButton.tsx"), "utf-8");
const profileSource = readFileSync(join(__dirname, "..", "src", "app", "actions", "profile.ts"), "utf-8");

test("saveListing tolerates a unique-violation from a concurrent duplicate save instead of reporting it as a failure", () => {
  assert.match(savedItemsSource, /error\.code !== "23505"/);
});

test("SaveButton surfaces the server action's error via a toast instead of silently reverting", () => {
  assert.match(saveButtonSource, /useToast/);
  assert.match(saveButtonSource, /showToast\(result\.error\)/);
});

test("updateProfile upserts (self-heals a missing profile row) instead of a plain update that fails on zero rows", () => {
  const fnBody = profileSource.slice(profileSource.indexOf("export async function updateProfile"));
  assert.match(fnBody, /\.upsert\(/);
  assert.match(fnBody, /onConflict: "id"/);
  assert.match(fnBody, /id: user\.id,/);
});
