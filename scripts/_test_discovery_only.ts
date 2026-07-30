import { discoverListingUrlsAtScale } from "@/lib/inventory/scaled-discovery";
import { getAllMarketplaceHealth } from "@/lib/inventory/marketplace-health";

async function main() {
  console.log("Health BEFORE:", JSON.stringify(getAllMarketplaceHealth()));
  const before = Date.now();
  const result = await discoverListingUrlsAtScale(20, new Set(), 2, 5, ["Vinted", "Depop", "Poshmark"]);
  console.log("Elapsed:", ((Date.now() - before) / 1000).toFixed(1), "s");
  console.log("RESULT:", JSON.stringify(result, null, 2));
  console.log("Health AFTER:", JSON.stringify(getAllMarketplaceHealth(), null, 2));
}
main().catch((e) => console.error("UNCAUGHT:", e));
