export type Aesthetic =
  | "Vintage"
  | "Y2K"
  | "Old Money"
  | "Streetwear"
  | "Cottagecore"
  | "Indie Sleaze";

export type MarketplaceSource =
  | "Depop"
  | "eBay"
  | "Etsy"
  | "Poshmark"
  | "Grailed";

export interface ClothingItem {
  id: string;
  name: string;
  brand: string;
  price: number;
  size: string;
  aesthetics: Aesthetic[];
  source: MarketplaceSource;
  image: string;
}

function photo(keywords: string, lock: number): string {
  return `https://loremflickr.com/600/800/${keywords}/all?lock=${lock}`;
}

function item(
  id: string,
  name: string,
  brand: string,
  price: number,
  size: string,
  aesthetics: Aesthetic[],
  source: MarketplaceSource,
  image: string,
): ClothingItem {
  return { id, name, brand, price, size, aesthetics, source, image };
}

export const MOCK_CLOTHING: ClothingItem[] = [
  // Vintage Americana
  item(
    "v1",
    "Vintage Ralph Lauren Sweater",
    "Ralph Lauren",
    35,
    "Small",
    ["Vintage"],
    "Depop",
    photo("vintage,sweater", 1),
  ),
  item(
    "v2",
    "90s Levi's Trucker Jacket",
    "Levi's",
    48,
    "Medium",
    ["Vintage", "Streetwear"],
    "eBay",
    photo("denim,jacket", 1),
  ),
  item(
    "v3",
    "Vintage Silk Scarf Blouse",
    "Unbranded",
    22,
    "Small",
    ["Vintage", "Old Money"],
    "Etsy",
    photo("vintage,blouse", 1),
  ),
  item(
    "v4",
    "Retro Corduroy Blazer",
    "Members Only",
    40,
    "Medium",
    ["Vintage"],
    "Depop",
    photo("tweed,blazer", 1),
  ),
  item(
    "v5",
    "Vintage Floral Midi Dress",
    "Laura Ashley",
    30,
    "Size 6",
    ["Vintage", "Cottagecore"],
    "Poshmark",
    photo("midi,dress", 1),
  ),

  // Y2K
  item(
    "y1",
    "Baby Tee with Butterfly Print",
    "Unbranded",
    18,
    "XS",
    ["Y2K"],
    "Depop",
    photo("crop,top", 1),
  ),
  item(
    "y2",
    "Low-Rise Cargo Pants",
    "Dickies",
    32,
    "28",
    ["Y2K", "Streetwear"],
    "Grailed",
    photo("cargo,trousers", 1),
  ),
  item(
    "y3",
    "Rhinestone Belt Bag",
    "Unbranded",
    15,
    "One Size",
    ["Y2K"],
    "Depop",
    photo("handbag,sparkle", 1),
  ),
  item(
    "y4",
    "Velour Tracksuit Set",
    "Juicy Couture",
    65,
    "Medium",
    ["Y2K"],
    "Poshmark",
    photo("velour,tracksuit", 1),
  ),
  item(
    "y5",
    "Platform Sneakers",
    "Skechers",
    38,
    "8",
    ["Y2K", "Streetwear"],
    "eBay",
    photo("retro,sneakers", 1),
  ),

  // Old Money
  item(
    "o1",
    "Cashmere Crewneck Sweater",
    "J.Crew",
    55,
    "Medium",
    ["Old Money"],
    "Poshmark",
    photo("crewneck,sweater", 1),
  ),
  item(
    "o2",
    "Pleated Tennis Skirt",
    "Ralph Lauren",
    42,
    "Size 4",
    ["Old Money"],
    "Depop",
    photo("tennis,outfit", 1),
  ),
  item(
    "o3",
    "Quilted Barn Jacket",
    "Barbour",
    95,
    "Small",
    ["Old Money"],
    "eBay",
    photo("barbour,jacket", 1),
  ),
  item(
    "o4",
    "Argyle Vest",
    "Brooks Brothers",
    28,
    "Medium",
    ["Old Money"],
    "Depop",
    photo("argyle,vest", 1),
  ),
  item(
    "o5",
    "Houndstooth Wool Coat",
    "Burberry",
    120,
    "Size 6",
    ["Old Money", "Vintage"],
    "Grailed",
    photo("houndstooth,coat", 1),
  ),

  // Streetwear
  item(
    "s1",
    "Oversized Graphic Hoodie",
    "Supreme",
    85,
    "Large",
    ["Streetwear"],
    "Grailed",
    photo("streetwear,hoodie", 1),
  ),
  item(
    "s2",
    "Baggy Denim Jeans",
    "Dickies",
    34,
    "32",
    ["Streetwear", "Y2K"],
    "Depop",
    photo("streetwear,jeans", 1),
  ),
  item(
    "s3",
    "Windbreaker Track Jacket",
    "Nike",
    26,
    "Medium",
    ["Streetwear"],
    "eBay",
    photo("streetwear,jacket", 1),
  ),
  item(
    "s4",
    "Bucket Hat",
    "Stussy",
    20,
    "One Size",
    ["Streetwear"],
    "Depop",
    photo("bucket,hat", 1),
  ),
  item(
    "s5",
    "Chunky Sneakers",
    "New Balance",
    58,
    "9",
    ["Streetwear"],
    "Poshmark",
    photo("streetwear,sneakers", 1),
  ),

  // Cottagecore
  item(
    "c1",
    "Puff Sleeve Linen Dress",
    "Unbranded",
    32,
    "Medium",
    ["Cottagecore"],
    "Etsy",
    photo("floral,sundress", 6),
  ),
  item(
    "c2",
    "Floral Prairie Skirt",
    "Free People",
    36,
    "Small",
    ["Cottagecore"],
    "Depop",
    photo("floral,skirt", 1),
  ),
  item(
    "c3",
    "Hand-Knit Cardigan",
    "Unbranded",
    28,
    "Medium",
    ["Cottagecore", "Vintage"],
    "Etsy",
    photo("knit,cardigan", 1),
  ),
  item(
    "c4",
    "Gingham Wrap Top",
    "Unbranded",
    18,
    "Small",
    ["Cottagecore"],
    "Poshmark",
    photo("gingham,blouse", 1),
  ),
  item(
    "c5",
    "Straw Sun Hat",
    "Unbranded",
    14,
    "One Size",
    ["Cottagecore"],
    "Etsy",
    photo("strawhat,summer", 1),
  ),

  // Indie Sleaze
  item(
    "i1",
    "Distressed Band Tee",
    "Unbranded",
    16,
    "Medium",
    ["Indie Sleaze"],
    "Depop",
    photo("grunge,tshirt", 1),
  ),
  item(
    "i2",
    "Leather Moto Jacket",
    "Unbranded",
    75,
    "Small",
    ["Indie Sleaze", "Vintage"],
    "Grailed",
    photo("leather,jacket", 1),
  ),
  item(
    "i3",
    "Fishnet Layering Top",
    "Unbranded",
    12,
    "One Size",
    ["Indie Sleaze"],
    "Depop",
    photo("fishnet,top", 1),
  ),
  item(
    "i4",
    "Skinny Scarf Necktie",
    "Unbranded",
    10,
    "One Size",
    ["Indie Sleaze"],
    "Etsy",
    photo("skinny,scarf", 1),
  ),
  item(
    "i5",
    "Smudged-Lens Sunglasses",
    "Unbranded",
    15,
    "One Size",
    ["Indie Sleaze", "Y2K"],
    "Depop",
    photo("grunge,sunglasses", 1),
  ),
];
