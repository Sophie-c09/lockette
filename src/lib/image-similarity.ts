// Visual Similarity Search Foundation — real embeddings, replacing
// today's "image -> text description -> keyword matching"
// (src/lib/garment-similarity-ranking.ts) with "image -> embedding ->
// closest images."
//
// IMPORTANT, HONEST CAVEAT ON WHAT "USING OPENAI_API_KEY" ACTUALLY MEANS
// HERE: OpenAI has no public endpoint that takes an image and returns an
// embedding directly (its /v1/embeddings endpoint is TEXT-only — no
// native CLIP-style image encoder is exposed). So generateImageEmbedding
// below is a real, two-step, working pipeline, not a native image
// embedding model:
//   1. gpt-4o-mini (vision) — the same model already used everywhere
//      else in this codebase (outfit-classification.ts, image-tagging.ts,
//      listing-enrichment.ts) — produces one dense, concrete paragraph
//      describing the garment's visual appearance (color, pattern,
//      material, silhouette, distinctive details).
//   2. text-embedding-3-small embeds THAT description.
// The resulting vector is real and derived from the actual image (via
// the vision step), and cosine similarity between two such vectors is a
// genuine, useful signal — but it's closer to "semantic similarity of a
// rich visual description" than true low-level/pixel-based visual
// similarity: two garments a human would call visually near-identical
// could still embed apart if the vision model happens to describe them
// differently, and this can't see purely visual similarity a description
// wouldn't capture (e.g. subtle shade differences). If OpenAI (or
// another provider) ever ships a native multimodal embedding endpoint,
// swapping the internals of generateImageEmbedding is the only change
// needed — compareImageSimilarity/rankByVisualSimilarity below don't
// care which model produced the vectors, only that both sides used the
// SAME one. At that point, also consider swapping
// marketplace_listings.image_embedding / listings.image_embedding /
// outfit_recreations.image_embedding (supabase/schema.sql) from a plain
// `double precision[]` to pgvector's `vector(N)` type and adding an
// ivfflat/hnsw index — this file's arrays work against either column
// shape, so nothing here needs to change for that swap either.
//
// NEVER FABRICATE AN EMBEDDING: a fake/placeholder vector (all zeros,
// random noise, a hash-based stand-in) would silently corrupt every
// future similarity comparison it's involved in — generateImageEmbedding
// returns null (a caller can tell "not available" from "here is a real
// embedding") on ANY failure (invalid URL, unreachable image, vision
// call failure, embedding call failure) rather than ever returning
// something that LOOKS like a valid embedding but isn't derived from the
// image at all.
import OpenAI from "openai";

const VISION_MODEL = "gpt-4o-mini";
const EMBEDDING_MODEL = "text-embedding-3-small";
const REQUEST_TIMEOUT_MS = 15_000;
const IMAGE_FETCH_TIMEOUT_MS = 8_000;

const VISUAL_DESCRIPTION_PROMPT = `You are describing ONE garment's visual appearance for an image-similarity search — not cataloging it into fields, just describing what it visually looks like in one dense paragraph.

Cover, in plain descriptive prose: garment type, color(s), pattern, material/texture, silhouette/fit/cut, and any distinctive visual details (buttons, hardware, trim, logos, stitching, distressing). Be specific and concrete — describe what the image shows, not a marketing description or a guess about brand/price.

Respond with ONLY the description paragraph — no headers, no bullet points, no extra commentary.`;

function logFailure(reason: string): void {
  console.log(`[Image Similarity] Failed generating embedding:\n${reason}`);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Confirms the image URL is actually reachable before spending an
 * OpenAI call on it — turns "invalid URL"/"image unavailable" into a
 * specific, early, cheap failure instead of a vaguer error surfacing
 * later from the vision call.
 */
async function assertImageReachable(imageUrl: string): Promise<string | null> {
  try {
    const response = await fetch(imageUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return `image unavailable (HTTP ${response.status})`;
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `image unavailable (${reason})`;
  }
}

async function describeImageForEmbedding(client: OpenAI, imageUrl: string): Promise<string | null> {
  const model = process.env.OPENAI_VISION_MODEL || VISION_MODEL;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: VISUAL_DESCRIPTION_PROMPT },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: imageUrl } }],
      },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() || null;
}

/**
 * Generates a real embedding vector for an image via a two-step pipeline
 * (vision description -> text embedding) — see this file's own header
 * comment for exactly what that means and its limits. Never throws:
 * returns null and logs `[Image Similarity] Failed generating embedding:
 * <reason>` for an invalid URL, an unreachable image, a missing API key,
 * or any OpenAI call failure.
 */
export async function generateImageEmbedding(imageUrl: string): Promise<number[] | null> {
  if (!imageUrl || !isValidHttpUrl(imageUrl)) {
    logFailure(`invalid image URL: "${imageUrl}"`);
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logFailure("OPENAI_API_KEY is not set");
    return null;
  }

  const unreachableReason = await assertImageReachable(imageUrl);
  if (unreachableReason) {
    logFailure(unreachableReason);
    return null;
  }

  try {
    const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });

    const description = await describeImageForEmbedding(client, imageUrl);
    if (!description) {
      logFailure("vision model returned no description");
      return null;
    }

    const embeddingModel = process.env.OPENAI_IMAGE_EMBEDDING_MODEL || EMBEDDING_MODEL;
    const response = await client.embeddings.create({
      model: embeddingModel,
      input: description,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      logFailure("embedding call returned no vector");
      return null;
    }

    console.log(`[Image Similarity] Generated embedding (dims=${embedding.length}, model=${embeddingModel})`);
    return embedding;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logFailure(reason);
    return null;
  }
}

export interface ListingSemanticEmbeddingInput {
  imageUrl?: string | null;
  title: string;
  description?: string | null;
}

/**
 * Hybrid search upgrade — generateImageEmbedding above embeds ONLY the
 * image (via its vision-description). This variant folds the listing's
 * own title/description text in alongside that same vision description
 * before the final embed call, so the resulting vector reflects
 * image+title+description jointly, not image alone — a title/description
 * often names things a generic visual description won't reliably catch
 * (brand, specific cut name, "Y2K", era) and vice versa (the image shows
 * the actual color/pattern/silhouette a sparse title might omit).
 *
 * The image is optional (`imageUrl` may be null/unreachable) — this still
 * returns a real, useful text-only embedding from title+description alone
 * rather than failing outright, since a listing without a usable photo
 * shouldn't be permanently unsearchable. Only returns null if there is
 * truly nothing to embed at all (no image AND no title/description) or
 * the embedding call itself fails — same "never fabricate a vector"
 * convention as generateImageEmbedding above.
 */
export async function generateListingSemanticEmbedding(input: ListingSemanticEmbeddingInput): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logFailure("OPENAI_API_KEY is not set");
    return null;
  }

  const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });

  let visualDescription: string | null = null;
  if (input.imageUrl && isValidHttpUrl(input.imageUrl)) {
    const unreachableReason = await assertImageReachable(input.imageUrl);
    if (!unreachableReason) {
      try {
        visualDescription = await describeImageForEmbedding(client, input.imageUrl);
      } catch (error) {
        // Non-fatal here — degrade to title/description text alone rather
        // than failing the whole embedding over a vision-step failure.
        logFailure(`vision step failed, continuing text-only (${error instanceof Error ? error.message : String(error)})`);
      }
    } else {
      logFailure(`vision step skipped, continuing text-only (${unreachableReason})`);
    }
  }

  const combinedText = [visualDescription, input.title, input.description]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(". ");

  if (!combinedText) {
    logFailure("nothing to embed (no image description, title, or description)");
    return null;
  }

  try {
    const embeddingModel = process.env.OPENAI_IMAGE_EMBEDDING_MODEL || EMBEDDING_MODEL;
    const response = await client.embeddings.create({
      model: embeddingModel,
      input: combinedText,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      logFailure("embedding call returned no vector");
      return null;
    }

    console.log(
      `[Image Similarity] Generated semantic embedding (dims=${embedding.length}, model=${embeddingModel}, hasImage=${Boolean(visualDescription)})`,
    );
    return embedding;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logFailure(reason);
    return null;
  }
}

/**
 * Cosine similarity between two embeddings, in [-1, 1] (in practice
 * [0, 1] for typical image embedding models, since their components are
 * rarely negative-dominant) — null (not 0, which would read as "totally
 * dissimilar") when either side is missing or the two vectors aren't the
 * same length (e.g. produced by two different, incompatible embedding
 * models), since neither case is a real, meaningful comparison.
 */
export function compareImageSimilarity(
  a: number[] | null | undefined,
  b: number[] | null | undefined,
): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return null;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface VisuallyRankableCandidate {
  imageEmbedding?: number[] | null;
}

/**
 * Ranks candidates by visual similarity to a query embedding, best-first.
 * Candidates with no embedding (every one, today — see this file's own
 * TODO) sort after every candidate that has one, but keep their
 * RELATIVE order among themselves (a stable partition, not a random
 * shuffle) — so calling this before real embeddings exist is a no-op:
 * every candidate is embedding-less, so the "no embedding" group is the
 * whole input, unchanged.
 *
 * queryEmbedding of null (also always true today) is an explicit no-op:
 * returns the input array unchanged rather than trying to rank against
 * nothing.
 */
export function rankByVisualSimilarity<T extends VisuallyRankableCandidate>(
  queryEmbedding: number[] | null,
  candidates: T[],
): T[] {
  if (!queryEmbedding) return candidates;

  const withScores = candidates.map((candidate, index) => ({
    candidate,
    index,
    similarity: compareImageSimilarity(queryEmbedding, candidate.imageEmbedding),
  }));

  withScores.sort((a, b) => {
    if (a.similarity == null && b.similarity == null) return a.index - b.index;
    if (a.similarity == null) return 1;
    if (b.similarity == null) return -1;
    return b.similarity - a.similarity;
  });

  return withScores.map(({ candidate }) => candidate);
}
