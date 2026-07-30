// Negative-learning signal extraction — pure function, no I/O (matches
// disliked-styles.ts's own "pure scoring logic" convention). Operates on
// admin_rejections rows already fetched by src/lib/learning-memory.ts.
//
// Deliberately simple as specified: a tag/fit needs 3+ past rejections
// before it's treated as "bad." Worth flagging: this is still more
// aggressive than this codebase's existing negative-signal precedent
// (disliked-styles.ts's assessListingAgainstDislikedStyles requires 4+
// recent occurrences before a hard exclusion) — implemented as given
// rather than second-guessed here; flag this to whoever tunes it later if
// 3 bad rejections ends up excluding too much good inventory.
export interface RejectionSignalInput {
  tags: string[] | null;
  fit: string | null;
}

export interface RejectionSignals {
  badTags: string[];
  badFits: string[];
}

export function extractRejectionSignals(items: RejectionSignalInput[]): RejectionSignals {
  const badTags = new Map<string, number>();
  const badFits = new Map<string, number>();

  for (const item of items) {
    item.tags?.forEach((tag) => {
      badTags.set(tag, (badTags.get(tag) || 0) + 1);
    });

    if (item.fit) {
      badFits.set(item.fit, (badFits.get(item.fit) || 0) + 1);
    }
  }

  return {
    // Only keep tags/fits that were rejected MULTIPLE times.
    badTags: Array.from(badTags.entries())
      .filter(([, count]) => count >= 3)
      .map(([tag]) => tag),

    badFits: Array.from(badFits.entries())
      .filter(([, count]) => count >= 3)
      .map(([fit]) => fit),
  };
}