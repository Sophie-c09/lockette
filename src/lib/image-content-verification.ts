// P0 launch-readiness fix (reverse-image search hardening) — Style Me and
// Recreate This Outfit both upload photos DIRECTLY from the browser to
// Supabase Storage (see style-me.ts/outfit-recreations.ts's own header
// comments), so there is no server-side Route Handler in the upload path
// itself to inspect the raw bytes as they arrive. The only content check
// that existed before this was client-side (`isAllowedListingPhotoType`,
// listing-photo.ts) against `File.type` — a browser-reported, spoofable
// value, not real content verification: a non-image file renamed to
// `.jpg` sails through it. This module is called AFTER the upload
// completes (both Server Actions already fetch the object right after
// upload anyway, to build a signed URL for AI classification), reading
// just enough of the real file bytes to check a genuine magic-number
// signature before anything downstream ever treats it as a real photo.
export type VerifiedImageKind = "jpeg" | "png" | "gif" | "webp" | "heic" | "unknown";

// Only the first 16 bytes are ever needed for any of these signatures.
const SNIFF_BYTES = 16;

function matchesBytes(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return Array.from(bytes.slice(offset, offset + length))
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

// HEIC/HEIF containers are ISO-BMFF: a 4-byte box size, then "ftyp", then a
// 4-byte major brand — the exact brands Apple's own HEIC/HEIF encoders
// write (confirmed against real iPhone-exported files: "heic" for a single
// image, "heix" for a 10-bit variant, "mif1"/"msf1" for the more generic
// HEIF container some tooling emits).
const HEIC_BRANDS = new Set(["heic", "heix", "mif1", "msf1", "heif"]);

/**
 * Sniffs real magic-number bytes — never trusts a declared Content-Type or
 * filename extension. "heic" is called out as its own distinct outcome
 * (not lumped into "unknown") so a caller can give an iPhone user a
 * specific, actionable message instead of a generic "invalid file" one —
 * this stack has no HEIC decoder, so a genuine HEIC upload is a real,
 * expected case to handle clearly, not a malformed/malicious file.
 */
export function detectImageKind(bytes: Uint8Array): VerifiedImageKind {
  if (matchesBytes(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (matchesBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (asciiAt(bytes, 0, 4) === "GIF8") return "gif";
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes.length >= 12 && asciiAt(bytes, 4, 4) === "ftyp" && HEIC_BRANDS.has(asciiAt(bytes, 8, 4))) return "heic";
  return "unknown";
}

export interface ImageVerificationResult {
  kind: VerifiedImageKind;
  // false whenever the caller should reject this upload outright — true
  // only for a real, decodable-by-this-stack image format.
  isUsable: boolean;
}

/**
 * Downloads just enough of an already-uploaded Storage object to verify
 * it's a real image, not whatever a spoofed Content-Type/extension
 * claimed. Never throws — a download failure (object missing, storage
 * error) reports `unknown`/not-usable, which callers treat as "reject,"
 * the same safe-by-default posture as this stack's other best-effort
 * checks.
 */
export async function verifyUploadedImage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches createClient's own generic default (see src/lib/supabase/server.ts)
  supabase: { storage: { from: (bucket: string) => any } },
  bucket: string,
  path: string,
): Promise<ImageVerificationResult> {
  try {
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error || !data) {
      console.error("[image-content-verification] Failed to download for verification:", bucket, path, error);
      return { kind: "unknown", isUsable: false };
    }

    const buffer = new Uint8Array(await data.arrayBuffer());
    const kind = detectImageKind(buffer.slice(0, SNIFF_BYTES));
    return { kind, isUsable: kind !== "unknown" && kind !== "heic" };
  } catch (error) {
    console.error("[image-content-verification] Verification threw unexpectedly:", bucket, path, error);
    return { kind: "unknown", isUsable: false };
  }
}
