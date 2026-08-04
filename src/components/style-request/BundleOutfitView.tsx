"use client";

// The AI-generated bundle's own display — a real Pinterest-style outfit
// collage (src/lib/outfit-preview.ts) where EVERY interaction happens on
// the outfit image itself: click a tile to open its side panel (name,
// price, platform, "Replace item"), hover to see its price overlaid on
// the photo. Deliberately no separate itemized list — the outfit IS the
// interface. Shared by /bundle/[id] (the page a user lands on
// immediately after submitting a request, often before generation has
// finished — see this file's own polling effect) and
// MyStyleRequestsView.tsx's embedded bundle view — one implementation,
// not two drifting copies.
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Loader2, X } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/Button";
import {
  addBundleToCart,
  getBundleById,
  getReplacementOptions,
  replaceBundleItem,
  retryBundleGeneration,
  type MyStyleRequestBundle,
  type MyStyleRequestBundleItem,
  type ReplacementOption,
} from "@/app/actions/style-requests";
import { BundleMoodboard, type BundleMoodboardItem } from "@/components/bundles/BundleMoodboard";
import { useToast } from "@/components/ToastProvider";

function parseUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function formatDeliveryRange(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const startDate = parseUtcDate(start);
  const endDate = parseUtcDate(end);
  const format: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const startLabel = startDate.toLocaleDateString("en-US", format);
  const endLabel =
    startDate.getUTCMonth() === endDate.getUTCMonth() ? String(endDate.getUTCDate()) : endDate.toLocaleDateString("en-US", format);
  return `Arrives ${startLabel}-${endLabel}`;
}

// "days + date" for the sticky purchase bar — e.g. "7-11 days · Arrives
// Aug 3-9". Computed from the CLIENT's own clock at render time (these
// are calendar dates, not stored durations), so this is a display-only
// estimate, same "never claimed as live tracking" framing as
// src/lib/shipping-estimator.ts's own header comment.
function formatDeliveryWithDays(start: string | null, end: string | null): string | null {
  const rangeLabel = formatDeliveryRange(start, end);
  if (!rangeLabel || !start || !end) return rangeLabel;

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const minDays = Math.max(0, Math.round((parseUtcDate(start).getTime() - todayUtc) / (24 * 60 * 60 * 1000)));
  const maxDays = Math.max(minDays, Math.round((parseUtcDate(end).getTime() - todayUtc) / (24 * 60 * 60 * 1000)));

  return `${minDays}-${maxDays} days · ${rangeLabel}`;
}

// While the bundle is 'generating' and the page needs fresh data — not
// so frequent it hammers the server, not so slow that "progressive"
// reveal feels sluggish.
const POLL_INTERVAL_MS = 2_500;

// P0 first-60-seconds fix — this polling loop previously had NO timeout
// at all: if generation genuinely never finished (an OpenAI outage, or
// any other real failure the server-side pipeline itself didn't catch),
// the user would watch the progress bar spin forever with no error, no
// retry, nothing. 2 minutes comfortably covers a real generation (vision
// analysis + several marketplace searches + embeddings, normally well
// under a minute) while still giving up on a genuinely stuck one.
const GENERATION_TIMEOUT_MS = 120_000;

// Mirrors the exact step values src/lib/bundle-generation.ts's
// runBundleGenerationAsync writes to generation_step, in order.
const GENERATION_STEP_LABELS: Record<string, string> = {
  starting: "Preparing your request",
  analyzing_inspiration: "Understanding your style",
  searching_items: "Finding matching pieces",
  ranking_matches: "Choosing the best options",
  building_preview: "Creating your outfit",
  complete: "Your bundle is ready",
};

function generationStepLabel(step: string | null): string {
  return (step && GENERATION_STEP_LABELS[step]) || GENERATION_STEP_LABELS.starting;
}

// Known, already-user-safe messages this app's own generation pipeline
// writes (bundle-generation.ts's fail() calls) — shown verbatim since
// they were written to be user-facing. Anything else (an unexpected
// caught exception's raw .message, which could contain internal/technical
// detail) falls back to a generic, safe message instead.
const KNOWN_SAFE_GENERATION_ERRORS = new Set([
  "Style request not found.",
  "This request has no inspiration photos to analyze.",
  // Superseded by "We couldn't process..." below now that a photo the
  // vision model can't find discrete garments in falls back to a
  // vibe-based bundle instead of failing (bundle-generation.ts) — kept
  // here so any bundle row already stored with this exact text (from
  // before that change) still displays correctly instead of falling
  // through to the generic message.
  "Couldn't identify any garments in the inspiration photo(s).",
  "We couldn't process the inspiration photo(s). Please try again.",
  "Couldn't find enough matching items for this outfit yet. Try again in a bit, or submit a new style request with a different photo.",
]);

function friendlyGenerationError(raw: string | null): string {
  if (raw && KNOWN_SAFE_GENERATION_ERRORS.has(raw)) return raw;
  return "Some items could not be found. Try submitting another inspiration photo.";
}

type PanelMode = "info" | "swap";

function ItemSidePanel({
  item,
  mode,
  onClose,
  onModeChange,
  onSwapped,
}: {
  item: MyStyleRequestBundleItem;
  mode: PanelMode;
  onClose: () => void;
  onModeChange: (mode: PanelMode) => void;
  onSwapped: () => void;
}) {
  const { showToast } = useToast();
  // null = "haven't fetched yet for this mount" — the parent gives this
  // component a fresh `key` per bundleItemId (see where it's rendered),
  // so this only ever needs to reset naturally via remount, never via an
  // explicit setState at the top of the effect (which the stricter
  // react-hooks lint rule flags as a cascading-render risk). Every
  // setOptions call here happens inside the async callback, in response
  // to the external fetch actually resolving.
  const [options, setOptions] = useState<ReplacementOption[] | null>(null);
  const [swappingId, setSwappingId] = useState<string | null>(null);
  const loading = mode === "swap" && options === null;

  useEffect(() => {
    if (mode !== "swap") return;
    let cancelled = false;

    getReplacementOptions(item.bundleItemId).then((result) => {
      if (cancelled) return;
      if (result.error) {
        showToast(result.error);
        setOptions([]);
        return;
      }
      setOptions(result.options);
    });

    return () => {
      cancelled = true;
    };
  }, [mode, item.bundleItemId, showToast]);

  async function handlePick(listingId: string) {
    setSwappingId(listingId);
    const result = await replaceBundleItem(item.bundleItemId, listingId);
    setSwappingId(null);

    if (result.error) {
      showToast(result.error);
      return;
    }
    showToast("Item replaced");
    onSwapped();
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink-strong/30" onClick={onClose} aria-hidden="true" />
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col overflow-y-auto bg-surface p-6 shadow-card">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold text-ink">
            {mode === "info" ? "Item details" : "Replace item"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-ink-soft hover:bg-inner"
          >
            <X className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>

        {mode === "info" && (
          <div className="mt-5 flex flex-col gap-4">
            <div className="aspect-square w-full overflow-hidden rounded-2xl bg-inner">
              {item.listing.image_url && (
                // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                <img
                  src={item.listing.image_url}
                  alt={item.listing.title}
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <div>
              <p className="font-display text-base font-semibold text-ink">{item.listing.title}</p>
              <p className="mt-1 text-lg font-semibold text-oxblood">${Number(item.listing.price ?? 0).toFixed(2)}</p>
              {item.listing.platform && (
                <p className="mt-0.5 text-sm text-ink-soft">Found on {item.listing.platform}</p>
              )}
            </div>
            <Button type="button" onClick={() => onModeChange("swap")} className="w-fit">
              Replace item
            </Button>
          </div>
        )}

        {mode === "swap" && (
          <div className="mt-5">
            <div className="rounded-2xl border border-border bg-inner/40 p-3">
              <p className="text-xs uppercase tracking-wide text-ink-soft">Current</p>
              <p className="mt-1 text-sm font-medium text-ink">{item.listing.title}</p>
              <p className="text-sm text-oxblood">${Number(item.listing.price ?? 0).toFixed(2)}</p>
            </div>

            {loading && <p className="mt-4 text-sm text-ink-soft">Finding similar alternatives…</p>}
            {!loading && options?.length === 0 && (
              <p className="mt-4 text-sm text-ink-soft">No similar alternatives found right now.</p>
            )}

            {!loading && options != null && options.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3">
                {options.map(({ listing }) => (
                  <button
                    key={listing.id}
                    type="button"
                    onClick={() => handlePick(listing.id)}
                    disabled={swappingId !== null}
                    className="flex flex-col overflow-hidden rounded-2xl border border-border text-left transition-colors hover:border-oxblood disabled:opacity-50"
                  >
                    <div className="relative aspect-square bg-inner">
                      {listing.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                        <img
                          src={listing.image_url}
                          alt={listing.title}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <div className="p-2">
                      <p className="truncate text-xs font-medium text-ink">{listing.title}</p>
                      <p className="text-xs text-oxblood">${Number(listing.price ?? 0).toFixed(2)}</p>
                      {swappingId === listing.id && <p className="text-xs text-ink-soft">Swapping…</p>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function BuyConfirmationModal({
  bundle,
  onClose,
}: {
  bundle: MyStyleRequestBundle;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  async function handleConfirm() {
    setConfirming(true);
    // Reuses the existing, already-real "Add All to Cart" action — actual
    // payment/checkout isn't built for this flow yet (explicitly out of
    // scope), so confirming here means "everything's in your cart, ready
    // for the existing checkout" rather than a new, separate purchase path.
    const result = await addBundleToCart(bundle.id);
    setConfirming(false);

    if (result.error) {
      showToast(result.error);
      return;
    }
    setConfirmed(true);
  }

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-strong/40 sm:items-center" onClick={onClose}>
        <div
          className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-6 sm:rounded-3xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h3 className="font-display text-lg font-semibold text-ink">
              {confirmed ? "Added to your cart" : "Confirm your outfit"}
            </h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-ink-soft hover:bg-inner"
            >
              <X className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>

          {confirmed ? (
            <div className="mt-5 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-ink-soft">
                Every piece is in your cart — head to checkout whenever you&apos;re ready.
              </p>
              <Button type="button" onClick={onClose} className="w-fit">
                Done
              </Button>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-col gap-2">
                {bundle.items.map(({ listing }) => (
                  <div key={listing.id} className="flex items-center gap-3 rounded-2xl bg-inner/40 px-3 py-2">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-inner">
                      {listing.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element -- arbitrary external marketplace domain, not known in advance
                        <img src={listing.image_url} alt={listing.title} className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{listing.title}</p>
                      <p className="text-xs text-ink-soft">{listing.platform ?? "Lockette"}</p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold text-oxblood">
                      ${Number(listing.price ?? 0).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm">
                <span className="text-ink-soft">
                  Subtotal ${Number(bundle.itemSubtotal ?? 0).toFixed(2)} + Lockette fee ${Number(bundle.mavelleFee ?? 0).toFixed(2)}
                </span>
                <span className="font-display text-base font-semibold text-ink">${Number(bundle.totalPrice ?? 0).toFixed(2)}</span>
              </div>

              <Button type="button" onClick={handleConfirm} disabled={confirming} className="mt-4 w-full">
                {confirming ? "Confirming…" : "Confirm Purchase"}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// The polished mid-generation experience — full version (title/subtitle,
// shown before any item has arrived) and a compact version (just the bar
// + step label, shown above the collage once items start appearing) so
// the "how far along" signal never disappears while status stays
// 'generating', it just shrinks out of the way once there's real content
// to look at.
function GenerationProgressBar({
  progress,
  step,
  compact = false,
}: {
  progress: number;
  step: string | null;
  compact?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, progress));

  return (
    <div className={compact ? "mt-3" : "mt-6 flex flex-col items-center text-center"}>
      {!compact && (
        <>
          <Loader2 className="h-8 w-8 animate-spin text-oxblood" strokeWidth={1.5} />
          <h3 className="mt-3 font-display text-xl font-semibold text-ink">Building your Lockette Bundle</h3>
          <p className="mt-1 text-sm text-ink-soft">Finding pieces that match your inspiration...</p>
        </>
      )}
      <div className={compact ? "w-full" : "mt-5 w-full max-w-xs"}>
        <div className="h-2 w-full overflow-hidden rounded-pill bg-inner">
          {/* Animates smoothly between poll-driven jumps (5 -> 20 -> 40 ->
              60 -> 80 -> 100) instead of snapping to each new value. */}
          <motion.div
            className="h-full rounded-pill bg-oxblood"
            initial={false}
            animate={{ width: `${clamped}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </div>
        <p className={`mt-2 text-xs text-ink-soft ${compact ? "" : "text-center"}`}>
          {generationStepLabel(step)} · {clamped}%
        </p>
      </div>
    </div>
  );
}

export function BundleOutfitView({
  bundle: initialBundle,
  onChanged,
}: {
  bundle: MyStyleRequestBundle;
  onChanged?: () => void;
}) {
  const { showToast } = useToast();
  const [bundle, setBundle] = useState(initialBundle);
  const [panelItem, setPanelItem] = useState<MyStyleRequestBundleItem | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("info");
  const [showBuyModal, setShowBuyModal] = useState(false);
  // Pre-launch polish fix (item 3) — the server-side pipeline is durable
  // now (runBundleGenerationAsync runs inside after(), see
  // src/app/actions/style-requests.ts's own comment), so a bundle that's
  // still 'generating' past this client's own polling window is very
  // likely still genuinely working, not stuck — this is why timing out
  // here no longer means "failed." It just means: stop hammering the
  // server every 2.5s and let the user leave/come back instead of
  // watching a frozen progress bar forever. Reopening this page (a fresh
  // server render — see /bundle/[id]/page.tsx) always reflects the real,
  // current status regardless of this flag; "Check now" (below) does the
  // same without a full navigation.
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [checkingNow, setCheckingNow] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Polling — only while actually generating; a no-op for the
  // already-'ready'/'error'/manual-bundle cases (MyStyleRequestsView.tsx
  // never even mounts this component until a request is 'completed', so
  // this effect fires at most once per /bundle/[id] visit in practice).
  // Depends on pollTimedOut (not just bundle.id/status) so "Check now"
  // resetting it back to false genuinely resumes polling with a fresh
  // timeout window, rather than needing a full page reload to try again.
  useEffect(() => {
    if (bundle.status !== "generating" || pollTimedOut) return;

    let cancelled = false;
    const startedAt = Date.now();
    const interval = setInterval(async () => {
      if (Date.now() - startedAt > GENERATION_TIMEOUT_MS) {
        clearInterval(interval);
        if (!cancelled) setPollTimedOut(true);
        return;
      }

      const result = await getBundleById(bundle.id);
      if (cancelled || !result.bundle) return;

      setBundle(result.bundle);
      if (result.bundle.status !== "generating") {
        clearInterval(interval);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [bundle.id, bundle.status, pollTimedOut]);

  // "Check now" — a single manual re-fetch for the calm, still-working
  // state below. If the bundle has actually finished (or failed) since
  // the client gave up automatic polling, this reveals that immediately;
  // if it's still generating, resuming polling (pollTimedOut -> false)
  // picks the automatic checks back up with a fresh timeout window,
  // rather than leaving the user stuck re-clicking forever.
  async function handleCheckNow() {
    setCheckingNow(true);
    const result = await getBundleById(bundle.id);
    setCheckingNow(false);
    if (!result.bundle) return;

    setBundle(result.bundle);
    if (result.bundle.status === "generating") {
      setPollTimedOut(false);
    }
  }

  // Retries a genuinely failed ("error") bundle in place — see
  // retryBundleGeneration's own doc comment (src/app/actions/
  // style-requests.ts) for why this can never duplicate the request or
  // the bundle. `retrying` both shows progress and guards against a
  // rapid double-click firing two retries at once.
  async function handleRetry() {
    if (retrying) return;

    setRetrying(true);
    const result = await retryBundleGeneration(bundle.id);
    setRetrying(false);

    if (!result.success) {
      showToast(result.error ?? "Something went wrong retrying this bundle. Please try again.");
      return;
    }

    // Optimistic — the server already flipped this row to 'generating';
    // reflecting that locally immediately (rather than waiting for the
    // next poll tick) is what makes the progress bar/polling effect above
    // pick back up right away instead of still showing the old error.
    setBundle((prev) => ({
      ...prev,
      status: "generating",
      generationStep: "starting",
      generationProgress: 5,
      generationError: null,
    }));
    setPollTimedOut(false);
  }

  function openPanel(item: MyStyleRequestBundleItem) {
    setPanelItem(item);
    setPanelMode("info");
  }

  // Same per-item data the old grid's buildOutfitPreviewLayout consumed
  // (listing id/image/category/price/title) — BundleMoodboard only
  // decides where each one floats, not what generation/matching/pricing
  // produced. Sorted by `position` so items found earliest anchor their
  // zone first, same ordering the old layout preserved.
  const moodboardItems: BundleMoodboardItem[] = [...bundle.items]
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      id: item.listing.id,
      imageUrl: item.listing.image_url,
      title: item.listing.title,
      price: item.listing.price,
      category: item.category,
      garmentType: item.category,
    }));

  function openPanelByListingId(listingId: string) {
    const bundleItem = bundle.items.find((item) => item.listing.id === listingId);
    if (bundleItem) openPanel(bundleItem);
  }

  const deliveryLabel = formatDeliveryWithDays(bundle.estimatedDeliveryStart, bundle.estimatedDeliveryEnd);
  // Pre-launch polish fix (item 3) — pollTimedOut and a genuine server-side
  // status === "error" used to be merged into one `isError` flag with
  // identical "we couldn't finish" copy. They're not the same thing: a
  // poll timeout just means this client stopped checking — generation is
  // durable server-side (after(), see style-requests.ts) and very likely
  // still finishing — while status === "error" means the pipeline itself
  // gave up. Keeping them visually/semantically distinct means the
  // still-working case never reads as a failure, and never loses the
  // request by offering to "submit a new one" for something still in flight.
  const isGenerating = bundle.status === "generating" && !pollTimedOut;
  const isStillWorking = bundle.status === "generating" && pollTimedOut;
  const isError = bundle.status === "error";
  const isReady = bundle.status === "ready" || bundle.status === "purchased";
  const isAiGenerated = isGenerating || isStillWorking || isError || bundle.itemSubtotal != null;

  return (
    <div className={isReady && isAiGenerated ? "pb-24" : undefined}>
      <h2 className="font-display text-lg font-semibold text-ink">Your Lockette Bundle</h2>

      {isGenerating && bundle.items.length === 0 && (
        <GenerationProgressBar progress={bundle.generationProgress} step={bundle.generationStep} />
      )}

      {bundle.description && <p className="mt-1 text-sm text-ink-soft">{bundle.description}</p>}

      {isStillWorking && (
        <div className="mt-3 rounded-2xl bg-highlight-cream px-4 py-3 text-sm text-ink">
          <p className="font-semibold">We&apos;ll keep working on your bundle</p>
          <p className="mt-1 text-ink-soft">
            This is taking longer than expected, but your request hasn&apos;t been lost — we&apos;re still putting
            it together. Check back here anytime, or come back later from My Style Requests.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleCheckNow} disabled={checkingNow}>
              {checkingNow ? "Checking..." : "Check now"}
            </Button>
            <LinkButton href="/my-style-requests" variant="secondary">
              My style requests
            </LinkButton>
          </div>
        </div>
      )}

      {isError && (
        <div className="mt-3 rounded-2xl bg-highlight-cream px-4 py-3 text-sm text-ink">
          <p className="font-semibold">We couldn&apos;t finish this bundle</p>
          <p className="mt-1 text-ink-soft">{friendlyGenerationError(bundle.generationError)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Try again"}
            </Button>
            <LinkButton href="/style-request" variant="secondary">
              Submit a new style request
            </LinkButton>
          </div>
        </div>
      )}

      {bundle.items.length === 0 && (isGenerating || isStillWorking) ? null : (
        <div className="mt-4">
          {isGenerating && bundle.items.length > 0 && (
            <GenerationProgressBar progress={bundle.generationProgress} step={bundle.generationStep} compact />
          )}
          <div className={isGenerating && bundle.items.length > 0 ? "mt-3" : undefined}>
            <BundleMoodboard items={moodboardItems} onItemClick={openPanelByListingId} />
          </div>
        </div>
      )}

      {panelItem && (
        <ItemSidePanel
          key={panelItem.bundleItemId}
          item={panelItem}
          mode={panelMode}
          onClose={() => setPanelItem(null)}
          onModeChange={setPanelMode}
          onSwapped={() => {
            setPanelItem(null);
            onChanged?.();
          }}
        />
      )}

      {showBuyModal && <BuyConfirmationModal bundle={bundle} onClose={() => setShowBuyModal(false)} />}

      {/* Sticky purchase bar — only once there's actually a real total to
          buy; never shown mid-generation or on a failed bundle. */}
      {isReady && isAiGenerated && (
        // Pre-launch polish fix (item 7) — pb uses env(safe-area-inset-bottom)
        // so this fixed purchase bar doesn't sit under the home-indicator
        // area on notched/gestural iOS devices (see AppTabBar.tsx's own fix).
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-6 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-card">
          <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-display text-base font-semibold text-ink">${Number(bundle.totalPrice ?? 0).toFixed(2)}</p>
              <p className="truncate text-xs text-ink-soft">
                Lockette fee included{deliveryLabel ? ` · ${deliveryLabel}` : ""}
              </p>
            </div>
            <Button type="button" onClick={() => setShowBuyModal(true)} className="shrink-0">
              Buy this outfit
            </Button>
          </div>
        </div>
      )}

      {/* Manual-bundle fallback (no pricing/sticky bar at all) keeps its
          original "Add All to Cart" affordance. */}
      {!isAiGenerated && (
        <Button
          type="button"
          onClick={async () => {
            const result = await addBundleToCart(bundle.id);
            if (result.error) {
              showToast(result.error);
              return;
            }
            showToast(`Added ${result.added} item${result.added === 1 ? "" : "s"} to your cart`);
          }}
          className="mt-4 w-fit"
        >
          Add All to Cart
        </Button>
      )}
    </div>
  );
}
