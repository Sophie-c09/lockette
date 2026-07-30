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
    limit: 5,
    mode: "fast",
    useScaledDiscovery: true,
    maxDiscoveryPagesPerQuery: 3,
  });
  console.log("Elapsed:", ((Date.now() - before) / 1000).toFixed(1), "s");
  console.log("RESULT_JSON_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("RESULT_JSON_END");
}
main().catch((e) => console.error("UNCAUGHT:", e));
