export interface StyleDnaInput {
  aesthetics: string[];
  brands: string[];
  categories: string[];
  colors: string[];
  size: string | null;
  budgetMax: number | null;
}

export interface FashionPersonality {
  label: string;
  blurb: string;
}

export interface StyleDna {
  styleName: string;
  description: string;
  personality: FashionPersonality;
}

interface StyleWord {
  adjective: string;
  noun: string;
  mood: string;
}

const STYLE_WORDS: Record<string, StyleWord> = {
  "Vintage Americana": {
    adjective: "Nostalgic",
    noun: "Americana",
    mood: "vintage Americana nostalgia",
  },
  "Old Money": {
    adjective: "Old Money",
    noun: "Classic",
    mood: "quiet, old-money polish",
  },
  Y2K: {
    adjective: "Y2K",
    noun: "Collector",
    mood: "Y2K maximalism",
  },
  "Indie Sleaze": {
    adjective: "Indie Sleaze",
    noun: "Rebel",
    mood: "flash-lit indie sleaze grit",
  },
  "Dark Academia": {
    adjective: "Dark Academia",
    noun: "Scholar",
    mood: "dark academia romance",
  },
  Cottagecore: {
    adjective: "Cottage",
    noun: "Romantic",
    mood: "cottagecore softness",
  },
  Streetwear: {
    adjective: "Streetwear",
    noun: "Curator",
    mood: "street-honed streetwear edge",
  },
  Minimalist: {
    adjective: "Modern",
    noun: "Minimalist",
    mood: "clean minimalist restraint",
  },
  Balletcore: {
    adjective: "Balletcore",
    noun: "Dreamer",
    mood: "balletcore delicacy",
  },
  Coastal: {
    adjective: "Coastal",
    noun: "Classic",
    mood: "coastal ease",
  },
};

const FALLBACK_STYLE: StyleWord = {
  adjective: "Curious",
  noun: "Explorer",
  mood: "an evolving, open-minded sense of style",
};

function formatList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function describeBudget(budgetMax: number | null): string {
  if (budgetMax == null) return "";
  if (budgetMax <= 25) {
    return "You keep an eye out for a steal — the thrill of the hunt matters as much as the find.";
  }
  if (budgetMax <= 50) {
    return "You're happy to spend a little more when a piece is really right.";
  }
  if (budgetMax <= 100) {
    return "You invest in pieces built to last rather than chasing every trend.";
  }
  return "Quality and rarity matter more to you than the price tag.";
}

function getFashionPersonality({
  aesthetics,
  brands,
  budgetMax,
}: StyleDnaInput): FashionPersonality {
  if (brands.length >= 4) {
    return {
      label: "The Collector",
      blurb:
        "You know exactly which labels earn a spot in your closet, and you're building a considered collection one great find at a time.",
    };
  }
  if (aesthetics.length >= 4) {
    return {
      label: "The Trend Explorer",
      blurb:
        "Your taste refuses to sit still — you move fluidly between eras and aesthetics, always curious about the next silhouette to try.",
    };
  }
  if (aesthetics.includes("Minimalist")) {
    return {
      label: "The Minimalist",
      blurb:
        "You'd rather own five perfect pieces than fifty good ones. Quality, fit, and restraint matter more to you than volume.",
    };
  }
  if (
    (aesthetics.includes("Vintage Americana") ||
      aesthetics.includes("Dark Academia") ||
      aesthetics.includes("Cottagecore")) &&
    (budgetMax ?? 0) > 0 &&
    (budgetMax ?? 0) <= 50
  ) {
    return {
      label: "The Vintage Hunter",
      blurb:
        "The thrill is in the find. You'll dig through a dozen racks for the one piece with real history and character.",
    };
  }
  if (
    aesthetics.includes("Streetwear") ||
    aesthetics.includes("Y2K") ||
    aesthetics.includes("Indie Sleaze")
  ) {
    return {
      label: "The Statement Maker",
      blurb:
        "Subtle isn't really your language — you dress to be noticed, mixing bold colors and eras into something entirely your own.",
    };
  }
  return {
    label: "The Style Explorer",
    blurb:
      "You're still discovering exactly what speaks to you, and that openness is its own kind of style.",
  };
}

export function generateStyleDna(input: StyleDnaInput): StyleDna {
  const { aesthetics, brands, categories, colors, budgetMax } = input;

  const primary = aesthetics[0] ? STYLE_WORDS[aesthetics[0]] : undefined;
  const secondary = aesthetics[1] ? STYLE_WORDS[aesthetics[1]] : undefined;

  const styleName = primary
    ? `${primary.adjective} ${secondary ? secondary.noun : primary.noun}`
    : `${FALLBACK_STYLE.adjective} ${FALLBACK_STYLE.noun}`;

  const moodPhrase = primary
    ? secondary
      ? `${primary.mood} with a touch of ${secondary.mood}`
      : primary.mood
    : FALLBACK_STYLE.mood;

  const colorPhrase = colors.length
    ? `You gravitate toward a palette of ${formatList(colors.slice(0, 3).map((color) => color.toLowerCase()))}`
    : "Your color story is still taking shape";

  const categoryPhrase = categories.length
    ? `always on the hunt for ${formatList(categories.slice(0, 3).map((category) => category.toLowerCase()))}`
    : "open to whatever catches your eye";

  const brandPhrase = brands.length
    ? `, with an eye for labels like ${formatList(brands.slice(0, 3))}`
    : "";

  const budgetPhrase = describeBudget(budgetMax);

  const description = `Your closet tells a story of ${moodPhrase}. ${colorPhrase}, and you're ${categoryPhrase}${brandPhrase}. ${budgetPhrase}`.trim();

  return {
    styleName,
    description,
    personality: getFashionPersonality(input),
  };
}
