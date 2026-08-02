import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This project is nested inside the Portfolio repo, which has its own
  // lockfile — pin the Turbopack root so it doesn't get inferred wrong.
  turbopack: {
    root: path.join(__dirname),
  },
  // Inventory Growth production crash fix — confirmed live that EVERY API
  // route importing @/lib/admin-scraper.ts (directly or transitively)
  // returned Vercel's generic static /500 HTML error page instead of that
  // route's own JSON, while routes that don't import it (e.g.
  // /api/inventory/index, /api/stripe/webhook) responded normally. That
  // module chain pulls in playwright (src/lib/browser-concurrency.ts,
  // src/lib/extraction/browser-extractor.ts, src/lib/marketplace-discovery.ts,
  // src/lib/inventory/scaled-discovery.ts) — a native-binary package Next's
  // bundler was trying to statically bundle for the serverless Function,
  // which is exactly the class of failure serverExternalPackages exists to
  // prevent: it tells Next to leave this package alone and `require` it
  // normally at runtime instead of bundling it, matching Next's own
  // documented guidance for native/binary Node dependencies (Playwright,
  // sharp, etc.) in Route Handlers.
  // @sparticuz/chromium added alongside playwright (same P0 launch-
  // readiness pass, see src/lib/browser-launch-options.ts) — it's the
  // exact same class of native/binary-shipping package, so it needs the
  // same "leave it alone, don't try to statically bundle it" treatment.
  serverExternalPackages: ["playwright", "@sparticuz/chromium"],
  // Continuous Import / Style-Aware Scraper root cause (the "Failed to
  // start the scraper" investigation) — confirmed live via the real
  // scraper_jobs.error_message this app's own failScraperJob recorded:
  // "Failed to load external module playwright-...: Error: Cannot find
  // module '/var/task/node_modules/playwright-core/browsers.json'".
  // serverExternalPackages above correctly stops Next from bundling
  // playwright's SOURCE into the JS bundle (leaving it as a plain
  // runtime `require`), but Vercel's own deployment file-tracer
  // (@vercel/nft, which decides which node_modules files actually ship
  // with each serverless Function) can't always tell that a package left
  // "external" this way still needs its own non-JS files (browsers.json,
  // the browser-registry manifest, etc.) physically present alongside
  // it — those are read via dynamic paths inside playwright-core's own
  // code, not statically-analyzable `require()` calls the tracer can
  // follow. outputFileTracingIncludes force-includes the whole
  // playwright/playwright-core package trees for the two routes that
  // actually launch a browser (this app never runs Playwright anywhere
  // else — see this repo's own "never import admin-scraper.ts from a
  // route real users' browsers wait on" convention), so the file the
  // deployed Function actually reaches for is there.
  // @sparticuz/chromium (added in this same P0 launch-readiness pass, see
  // src/lib/browser-launch-options.ts's own header comment) ships its OWN
  // compressed Chromium build INSIDE its npm package specifically so
  // ordinary node_modules file-tracing picks it up — unlike a normal
  // Playwright install, whose actual browser executable lives in an
  // OS-level cache directory outside node_modules entirely and can never
  // be reached by any node_modules/** glob, browsers.json notwithstanding.
  outputFileTracingIncludes: {
    "/api/admin-scraper/run": [
      "./node_modules/playwright/**",
      "./node_modules/playwright-core/**",
      "./node_modules/@sparticuz/chromium/**",
    ],
    "/api/admin-scraper/large-scale/process-batch": [
      "./node_modules/playwright/**",
      "./node_modules/playwright-core/**",
      "./node_modules/@sparticuz/chromium/**",
    ],
  },
  // Default Server Action body limit is 1MB — too small for Recreate This
  // Outfit's photo upload (RecreateOutfitForm.tsx posts the image File
  // directly to classifyOutfitPhotoForRecreation, a Server Action), which
  // was failing with "Body exceeded 1 MB limit." bodySizeLimit is a single
  // global ceiling — Next.js has no per-Server-Action override — so it has
  // to cover the largest multipart request any Server Action makes across
  // the whole app. That's currently Style Request's inspo photo upload
  // (StyleRequestForm.tsx -> submitStyleRequest): up to MAX_LISTING_PHOTOS
  // images at MAX_STYLE_REQUEST_PHOTO_BYTES (10MB) each, capped at 30MB
  // total client-side (MAX_TOTAL_SIZE). This limit applies to the RAW
  // request body though — multipart/form-data boundaries, part headers,
  // and the other form fields (inspoText/budget/categories) all add to
  // it on top of the 30MB of photo bytes — so both limits below are set
  // to 40mb, not 30mb, to leave real headroom above the client's 30MB cap.
  //
  // Two SEPARATE limits both have to clear that 30MB client cap, not just
  // bodySizeLimit: src/proxy.ts's matcher covers /style-request (and
  // every other non-static route), and whenever a proxy is active, Next
  // clones and buffers the request body — for both the proxy itself and
  // the underlying route handler — up to proxyClientMaxBodySize, which
  // defaults to 10MB. That default silently truncated large Style Request
  // uploads before they ever reached the Server Action's own multipart
  // parser, which is what actually produced "Unexpected end of form"
  // (a truncated/incomplete multipart body) even after bodySizeLimit was
  // already raised — bodySizeLimit never got a chance to matter, since
  // the body was already cut short one layer earlier. Both settings now
  // have to move together for any future increase to this upload limit.
  experimental: {
    serverActions: {
      bodySizeLimit: "40mb",
    },
    proxyClientMaxBodySize: "40mb",
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "loremflickr.com",
      },
      // Curated homepage category cover photos (src/lib/aesthetic-categories.ts)
      // — free-tier Unsplash CDN.
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      // User-picked homepage category cover photos (aesthetic-categories.ts)
      // resolved from Pinterest pins' og:image and a Poshmark listing's
      // og:image, respectively — see that file for the full explanation.
      {
        protocol: "https",
        hostname: "i.pinimg.com",
      },
      {
        protocol: "https",
        hostname: "di2ponv0v5otw.cloudfront.net",
      },
      // Vinted's CDN shards image hosts across images1-4.vinted.net.
      {
        protocol: "https",
        hostname: "images1.vinted.net",
      },
      {
        protocol: "https",
        hostname: "images2.vinted.net",
      },
      {
        protocol: "https",
        hostname: "images3.vinted.net",
      },
      {
        protocol: "https",
        hostname: "images4.vinted.net",
      },
      // Wildcard, not just images.depop.com: real imported Depop listings
      // serve images from media-photos.depop.com, not images.depop.com —
      // confirmed against the live listings table.
      {
        protocol: "https",
        hostname: "**.depop.com",
      },
    ],
  },
};

export default nextConfig;
