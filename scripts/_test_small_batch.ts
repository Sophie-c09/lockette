import { runAdminScraper } from "@/lib/admin-scraper";

async function main() {
  const before = Date.now();
  const result = await runAdminScraper({
    maxPrice: 25,
    minStyleScore: 15,
    minImageScore: 60,
    allowedSources: ["vinted", "depop"],
    brandMode: null,
    categoryFilter: null,
    limit: 5, // tiny target so the round loop completes fast
    mode: "fast",
    useScaledDiscovery: true,
    maxDiscoveryPagesPerQuery: 3,
  });
  console.log("Elapsed:", ((Date.now() - before) / 1000).toFixed(1), "s");
  console.log("Result:", JSON.stringify(result, null, 2));
}
main().catch((e) => console.error("UNCAUGHT:", e));
