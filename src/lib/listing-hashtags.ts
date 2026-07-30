// Parses a seller's raw hashtag input (e.g. "#y2k #lowrise #babytee") for
// /sell and the Discover/Feed edit modal into the same `#Capitalized`
// convention aesthetic_tags already uses for scraped listings — see
// formatTag's own comment in clean-description.ts for why the convention
// must match exactly. Written straight into aesthetic_tags (no separate
// `hashtags` column) so a seller's own tags immediately feed the same
// Discover/Feed/Match scoring every scraped listing's tags already do.
import { formatTag, isExcludedTag } from "@/lib/extraction/clean-description";

const HASHTAG_PATTERN = /#(\w+)/g;

export function parseHashtagsToAestheticTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const match of raw.matchAll(HASHTAG_PATTERN)) {
    const word = match[1].toLowerCase();
    if (isExcludedTag(word)) continue;

    const formatted = formatTag(word);
    if (seen.has(formatted)) continue;
    seen.add(formatted);
    tags.push(formatted);
  }

  return tags;
}
