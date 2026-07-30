// Positive-learning signal extraction — structurally parallel to
// src/lib/rejection-learning.ts (same "pure function" simplicity). A
// tag/fit/aesthetic needs 2+ past approvals before it counts as "good" —
// a slightly lower bar than negative signals' 3+, since a false-positive
// boost is much lower-stakes than a false-positive hard rejection.
// Operates on approved_items rows already fetched by
// src/lib/learning-memory.ts.
export interface PositiveSignalInput {
  tags: string[] | null;
  fit: string | null;
  aesthetic: string[] | null;
}

export interface PositiveSignals {
  goodTags: string[];
  goodFits: string[];
  goodAesthetics: string[];
}

export function extractPositiveSignals(items: PositiveSignalInput[]): PositiveSignals {
  const goodTags = new Map<string, number>();
  const goodFits = new Map<string, number>();
  const goodAesthetics = new Map<string, number>();

  for (const item of items) {
    item.tags?.forEach((tag) => {
      goodTags.set(tag, (goodTags.get(tag) || 0) + 1);
    });

    if (item.fit) {
      goodFits.set(item.fit, (goodFits.get(item.fit) || 0) + 1);
    }

    item.aesthetic?.forEach((a) => {
      goodAesthetics.set(a, (goodAesthetics.get(a) || 0) + 1);
    });
  }

  return {
    goodTags: Array.from(goodTags.entries())
      .filter(([, count]) => count >= 2)
      .map(([tag]) => tag),

    goodFits: Array.from(goodFits.entries())
      .filter(([, count]) => count >= 2)
      .map(([fit]) => fit),

    goodAesthetics: Array.from(goodAesthetics.entries())
      .filter(([, count]) => count >= 2)
      .map(([aesthetic]) => aesthetic),
  };
}