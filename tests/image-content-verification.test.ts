// Covers the P0 launch-readiness reverse-image-search hardening fix — real
// magic-number content verification (image-content-verification.ts),
// replacing a client-side-only File.type check that a renamed non-image
// file could trivially bypass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectImageKind } from "@/lib/image-content-verification";

test("detects a real JPEG by its magic bytes", () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  assert.equal(detectImageKind(bytes), "jpeg");
});

test("detects a real PNG by its magic bytes", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  assert.equal(detectImageKind(bytes), "png");
});

test("detects a real GIF by its magic bytes", () => {
  const bytes = new Uint8Array(Buffer.from("GIF89a"));
  assert.equal(detectImageKind(bytes), "gif");
});

test("detects a real WebP by its RIFF/WEBP magic bytes", () => {
  const bytes = new Uint8Array(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]));
  assert.equal(detectImageKind(bytes), "webp");
});

test("detects a real HEIC container as its own distinct outcome, not 'unknown'", () => {
  const bytes = new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftyp"), Buffer.from("heic")]));
  assert.equal(detectImageKind(bytes), "heic");
});

test("a PDF renamed to .jpg is detected as unknown, never misclassified as a real image", () => {
  const bytes = new Uint8Array(Buffer.from("%PDF-1.4\n"));
  assert.equal(detectImageKind(bytes), "unknown");
});

test("a plain text file is detected as unknown", () => {
  const bytes = new Uint8Array(Buffer.from("just some text pretending to be a photo"));
  assert.equal(detectImageKind(bytes), "unknown");
});

test("an empty buffer is unknown, never throws", () => {
  assert.doesNotThrow(() => detectImageKind(new Uint8Array(0)));
  assert.equal(detectImageKind(new Uint8Array(0)), "unknown");
});

test("a bare 'sold'-style seller text embedded in bytes never accidentally matches an image signature", () => {
  const bytes = new Uint8Array(Buffer.from("RIFF but not actually webp data at all"));
  assert.equal(detectImageKind(bytes), "unknown");
});
