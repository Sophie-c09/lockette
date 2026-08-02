// Covers the P0 launch-readiness DB-level protection migrations — these
// need a real Postgres/Supabase instance to actually apply and verify, so
// this asserts the migration files exist with the expected, safe shape
// (conditional on status='active', NOT VALID, pre-dedup before a unique
// index) rather than duplicating a database test here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(__dirname, "..", "supabase", "migrations");

function readMigration(filename: string): string {
  return readFileSync(join(migrationsDir, filename), "utf-8");
}

test("listings price/title/image constraints are conditional on status='active', not a blanket check", () => {
  const sql = readMigration("20260801000400_add_listings_active_row_constraints.sql");
  assert.match(sql, /check \(status <> 'active' or \(price is not null and price > 0\)\)/);
  assert.match(sql, /check \(status <> 'active' or \(title is not null and length\(trim\(title\)\) > 0\)\)/);
  assert.match(sql, /check \(status <> 'active' or \(image_url is not null and length\(trim\(image_url\)\) > 0\)\)/);
});

test("the active-row constraints are NOT VALID — existing rows are never retroactively broken", () => {
  const sql = readMigration("20260801000400_add_listings_active_row_constraints.sql");
  const notValidCount = (sql.match(/not valid;/g) ?? []).length;
  assert.equal(notValidCount, 3, "expected all three CHECK constraints to be added NOT VALID");
});

test("active-row product_url duplicates are demoted BEFORE the unique index is created, not after", () => {
  const sql = readMigration("20260801000400_add_listings_active_row_constraints.sql");
  const updateIndex = sql.indexOf("set status = 'rejected'");
  const indexIndex = sql.indexOf("create unique index");
  assert.ok(updateIndex > -1 && indexIndex > -1 && updateIndex < indexIndex);
});

test("the product_url uniqueness is a PARTIAL index scoped to active rows, not a whole-table constraint", () => {
  const sql = readMigration("20260801000400_add_listings_active_row_constraints.sql");
  assert.match(sql, /create unique index if not exists listings_active_product_url_unique\s*\n\s*on public\.listings \(product_url\)\s*\n\s*where status = 'active';/);
});

test("scraper_url_queue.claimed_at migration exists and adds the column the race fix depends on", () => {
  const sql = readMigration("20260801000100_add_scraper_url_queue_claimed_at.sql");
  assert.match(sql, /add column if not exists claimed_at timestamptz/);
});

test("scraper_jobs batch-lease migration exists and adds both columns claimBatchLease depends on", () => {
  const sql = readMigration("20260801000200_add_scraper_jobs_batch_lease.sql");
  assert.match(sql, /add column if not exists batch_lease_id uuid/);
  assert.match(sql, /add column if not exists batch_lease_expires_at timestamptz/);
});

test("saved_items unique-constraint migration dedupes existing rows before adding the constraint", () => {
  const sql = readMigration("20260801000300_add_saved_items_listing_unique_constraint.sql");
  const deleteIndex = sql.indexOf("delete from public.saved_items");
  const constraintIndex = sql.indexOf("add constraint saved_items_user_listing_unique");
  assert.ok(deleteIndex > -1 && constraintIndex > -1 && deleteIndex < constraintIndex);
});
