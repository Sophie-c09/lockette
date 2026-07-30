"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Camera, Sparkles } from "lucide-react";
import {
  classifyOutfitPhotoForRecreation,
  submitOutfitRecreation,
  type SubmitOutfitRecreationInput,
} from "@/app/actions/outfit-recreations";
import { Button } from "@/components/ui/Button";
import { isAllowedListingPhotoType, MAX_LISTING_PHOTO_BYTES } from "@/lib/listing-photo";
import { BUDGET_OPTIONS, type BudgetOption } from "@/lib/budget-options";
import type { OutfitCategory } from "@/lib/outfit-classification";
import type { DetectedGarment } from "@/lib/garment-detection";

// Widened from the old top/bottom/layer vocabulary to the full garment
// vocabulary (src/lib/garment-detection.ts) so accessories/bags/shoes/
// outerwear/dresses can actually be labeled now that classification can
// detect them — see outfit-classification.ts's own comment.
const CATEGORY_LABELS: Record<OutfitCategory, string> = {
  tops: "Top",
  dresses: "Dress",
  bottoms: "Bottoms",
  outerwear: "Outerwear",
  shoes: "Shoes",
  bags: "Bag",
  accessories: "Accessory",
};

// "Find This Look" — two steps, not one flat form: a per-category budget
// selector ("Jacket budget / Pants budget / Shoes budget," in this app's
// real top/bottom/layer vocabulary) can only be shown once the pieces are
// actually detected, so classification has to run and return to the
// client BEFORE any budget choice is possible. Backend untouched
// (src/app/actions/outfit-recreations.ts) — this file only changed
// presentation/copy and added the step transition.
type Step = "upload" | "classifying" | "budget" | "submitting";

interface Classified {
  photoPath: string;
  items: DetectedGarment[];
  categories: OutfitCategory[];
  aestheticTags: string[];
}

export function RecreateOutfitForm() {
  const [step, setStep] = useState<Step>("upload");
  const [error, setError] = useState<string | null>(null);
  const [classified, setClassified] = useState<Classified | null>(null);
  const [budgetByCategory, setBudgetByCategory] = useState<Partial<Record<OutfitCategory, BudgetOption>>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!isAllowedListingPhotoType(file.type)) {
      setPhotoError("Photo must be JPEG, PNG, WebP, or GIF.");
      event.target.value = "";
      return;
    }
    if (file.size > MAX_LISTING_PHOTO_BYTES) {
      setPhotoError("Photo must be 5MB or smaller.");
      event.target.value = "";
      return;
    }

    setPhotoError(null);
    setPreview(URL.createObjectURL(file));
  }

  async function handleClassify(formData: FormData) {
    setError(null);
    setStep("classifying");

    const result = await classifyOutfitPhotoForRecreation(formData);

    if (result.error || !result.photoPath || !result.categories || !result.items) {
      setError(result.error ?? "Couldn't process that photo. Please try again.");
      setStep("upload");
      return;
    }

    setClassified({
      photoPath: result.photoPath,
      items: result.items,
      categories: result.categories,
      aestheticTags: result.aestheticTags ?? [],
    });
    // Every detected piece starts at "Any price" — the same no-cap-
    // unless-you-choose-one default the item-level budget selector uses
    // elsewhere (src/lib/budget-options.ts).
    setBudgetByCategory(Object.fromEntries(result.categories.map((category) => [category, "any"])));
    setStep("budget");
  }

  function handleChoosePhoto() {
    setClassified(null);
    setError(null);
    setStep("upload");
  }

  async function handleSubmit() {
    if (!classified) return;
    setError(null);
    setStep("submitting");

    const input: SubmitOutfitRecreationInput = {
      photoPath: classified.photoPath,
      items: classified.items,
      categories: classified.categories,
      aestheticTags: classified.aestheticTags,
      budgetByCategory,
    };

    const result = await submitOutfitRecreation(input);
    // A successful call redirects server-side and never returns — only an
    // error path actually reaches here.
    if (result?.error) {
      setError(result.error);
      setStep("budget");
    }
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <AnimatePresence mode="wait">
        {step === "budget" || step === "submitting" ? (
          <motion.div
            key="budget"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <span className="font-display text-xs uppercase tracking-[0.25em] text-oxblood">Find This Look</span>
            <h1 className="mt-2 font-display text-2xl font-semibold text-ink">Set a budget per piece</h1>
            <p className="mt-2 text-sm text-ink-soft">
              We found {classified?.categories.length ?? 0} piece
              {classified?.categories.length === 1 ? "" : "s"} in your photo — pick a price range
              for each before we search for matches.
            </p>

            <div className="mt-8 flex flex-col gap-7">
              {classified?.categories.map((category) => (
                <div key={category}>
                  <span className="mb-2 block text-sm font-medium text-ink">
                    {CATEGORY_LABELS[category] ?? category} budget
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {BUDGET_OPTIONS.map((option) => (
                      <Button
                        key={option.value}
                        type="button"
                        variant={budgetByCategory[category] === option.value ? "primary" : "secondary"}
                        onClick={() =>
                          setBudgetByCategory((prev) => ({ ...prev, [category]: option.value }))
                        }
                        className="w-fit"
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {error && (
              <p className="mt-5 rounded-card bg-highlight-cream px-4 py-3 text-sm text-ink">{error}</p>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button type="button" onClick={handleSubmit} disabled={step === "submitting"} className="w-fit">
                <Sparkles className="h-4 w-4" strokeWidth={2} />
                {step === "submitting" ? "Styling your outfit…" : "Recreate This Outfit"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleChoosePhoto}
                disabled={step === "submitting"}
                className="w-fit"
              >
                Choose a different photo
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="upload"
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <span className="font-display text-xs uppercase tracking-[0.25em] text-oxblood">Reverse Search</span>
            <h1 className="mt-2 font-display text-2xl font-semibold text-ink">Find This Look</h1>
            <p className="mt-2 text-sm text-ink-soft">
              Upload a photo of an outfit you love — your stylist will find real secondhand pieces
              to match it, right now.
            </p>

            <form action={handleClassify} className="mt-8 flex flex-col gap-5">
              <div>
                <div className="flex h-64 w-full items-center justify-center overflow-hidden rounded-card border border-dashed border-border-button bg-inner transition-colors">
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a freshly-picked local file (blob: URL), not known in advance
                    <img src={preview} alt="Outfit preview" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-ink-soft">
                      <Camera className="h-8 w-8" strokeWidth={1.5} />
                      <span className="text-sm">No photo selected</span>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  name="image"
                  required
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3"
                >
                  {preview ? "Change photo" : "Choose photo"}
                </Button>
                <p className="mt-1.5 text-xs text-ink-soft">JPEG, PNG, WebP, or GIF. 5MB max.</p>
                {photoError && <p className="mt-1.5 text-xs text-oxblood">{photoError}</p>}
              </div>

              <div>
                <label htmlFor="inspoText" className="mb-1.5 block text-sm font-medium text-ink">
                  Anything else to know? (optional)
                </label>
                <textarea
                  id="inspoText"
                  name="inspoText"
                  rows={3}
                  placeholder="e.g. I run cold, prefer looser fits"
                  className="w-full rounded-card border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
                />
              </div>

              {error && (
                <p className="rounded-card bg-highlight-cream px-4 py-3 text-sm text-ink">{error}</p>
              )}

              <Button type="submit" disabled={step === "classifying"} className="w-fit">
                <Sparkles className="h-4 w-4" strokeWidth={2} />
                {step === "classifying" ? "Looking at your photo…" : "Find This Look"}
              </Button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
