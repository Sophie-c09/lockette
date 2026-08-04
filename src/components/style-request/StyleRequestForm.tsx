"use client";

import { startTransition, useActionState, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, X } from "lucide-react";
import { submitStyleRequest, type SubmitStyleRequestState } from "@/app/actions/style-requests";
import { Button } from "@/components/ui/Button";
import { isAllowedListingPhotoType, MAX_LISTING_PHOTOS, MAX_STYLE_REQUEST_PHOTO_BYTES } from "@/lib/listing-photo";
import { SELECTED_CATEGORY_OPTIONS, type SelectedCategory } from "@/lib/selected-categories";
import { STYLE_REQUEST_BUDGET_OPTIONS } from "@/lib/style-request-budget";

const initialState: SubmitStyleRequestState = undefined;

// Separate from MAX_STYLE_REQUEST_PHOTO_BYTES (the per-image cap) — this
// bounds the SUM across every inspo photo in one submission, since up to
// MAX_LISTING_PHOTOS images at the per-image cap could otherwise add up
// to far more than any single request should carry.
const MAX_TOTAL_SIZE = 30 * 1024 * 1024; // 30MB

interface PhotoPreview {
  file: File;
  previewUrl: string;
}

export function StyleRequestForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(submitStyleRequest, initialState);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<PhotoPreview[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<SelectedCategory[]>([]);

  // The hidden input below is a picker ONLY — `photos` state (real File
  // objects) is the single source of truth for what actually gets
  // submitted (see handleSubmit), so this never writes anything back to
  // the input's own `.files`. Resetting `.value` here, every time, is
  // what makes that safe: a native multi-file input's FileList can't be
  // edited in place (no removing a single file from it), and the
  // previous approach worked around that by reassigning `.files` via a
  // DataTransfer-constructed FileList — but reopening that SAME input's
  // OS picker dialog for a later "Add more photos" round is a documented
  // source of cross-browser inconsistency (some browsers/OS dialogs
  // treat an input's existing selection as still "current"), which could
  // silently recapture earlier files alongside new ones and inflate the
  // real submitted payload past what the UI showed — the actual cause of
  // "Unexpected end of form" on larger multi-photo submissions. Clearing
  // `.value` immediately means the input never has a standing selection
  // for a later dialog to remember.
  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    setPhotoError(null);
    setError(null);
    const next = [...photos];
    let totalSize = next.reduce((sum, photo) => sum + photo.file.size, 0);

    for (const file of files) {
      if (!isAllowedListingPhotoType(file.type)) {
        setPhotoError("Photos must be JPEG, PNG, WebP, or GIF.");
        continue;
      }
      if (file.size > MAX_STYLE_REQUEST_PHOTO_BYTES) {
        setPhotoError("Each image must be under 10MB");
        continue;
      }
      if (next.length >= MAX_LISTING_PHOTOS) {
        setPhotoError(`You can upload up to ${MAX_LISTING_PHOTOS} photos.`);
        break;
      }
      if (totalSize + file.size > MAX_TOTAL_SIZE) {
        setPhotoError("Total upload size must be under 30MB");
        break;
      }
      next.push({ file, previewUrl: URL.createObjectURL(file) });
      totalSize += file.size;
    }

    setPhotos(next);
  }

  function handleRemovePhoto(index: number) {
    setPhotoError(null);
    setPhotos((prev) => {
      URL.revokeObjectURL(prev[index].previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  function toggleCategory(category: SelectedCategory) {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((entry) => entry !== category) : [...prev, category],
    );
  }

  // Bundle generation needs a real photo to run vision analysis on, so
  // this is enforced client-side before the request ever leaves the
  // browser — submitStyleRequest (src/app/actions/style-requests.ts)
  // has the same rule as a server-side backstop, not a duplicate source
  // of truth.
  //
  // The form below has no `action` prop — submission is handled entirely
  // here so the FormData sent to the Server Action can be built straight
  // from `photos` state (the real, validated File objects) instead of
  // from the hidden input's own FileList. `new FormData(event.currentTarget)`
  // still picks up every other field (inspoText/budget/categories)
  // exactly as the native form-action wiring would have.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (photos.length === 0) {
      setError("Add at least one inspiration photo to generate your bundle");
      return;
    }
    setError(null);

    const formData = new FormData(event.currentTarget);
    formData.delete("images");
    for (const photo of photos) {
      formData.append("images", photo.file);
    }

    startTransition(() => {
      formAction(formData);
    });
  }

  // Brief now — submitStyleRequest only awaits the upload + one fast
  // "generating" row insert before redirecting to /bundle/{id}. The actual
  // AI pipeline (vision analysis, marketplace search, ranking) runs async
  // AFTER that redirect, so the real "building your bundle" experience —
  // skeleton tiles, progressive item reveal — lives on the bundle page
  // itself (BundleOutfitView), not here. This state just covers the upload.
  if (pending) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-24 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-oxblood" strokeWidth={1.5} />
        <h1 className="font-display text-xl font-semibold text-ink">Sending your request…</h1>
        <p className="text-sm text-ink-soft">Uploading your photos and starting your bundle.</p>
      </div>
    );
  }

  if (state?.requestId) {
    // Pre-submission fix — this branch is only reached when
    // createGeneratingBundle itself failed for a reason OTHER than a
    // missing photo (see submitStyleRequest's own comment in
    // style-requests.ts) — a real inspiration photo is already guaranteed
    // present here, so the old "add a photo" copy was actively wrong,
    // not just imprecise, and read as a cheerful success message for what
    // is actually a backend hiccup.
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <Sparkles className="mx-auto h-8 w-8 text-oxblood" strokeWidth={1.5} />
        <h1 className="mt-3 font-display text-2xl font-semibold text-ink">We hit a snag starting your bundle</h1>
        <p className="mt-3 text-sm text-ink-soft">
          Your request was saved, but we couldn&apos;t start building your bundle just yet. Check My Style Requests in
          a bit, or send it again.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button variant="secondary" onClick={() => router.push("/my-style-requests")}>
            My style requests
          </Button>
          {/* Hard navigation — same route means the App Router wouldn't
              remount this component on a soft nav, which would leave the
              success screen showing instead of a fresh form. */}
          <Button variant="primary" onClick={() => window.location.assign("/style-request")}>
            Send another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">Get Styled</h1>
      <p className="mt-2 text-sm text-ink-soft">
        Share your inspiration and we&apos;ll hand-pick a curated bundle just for you.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-5">
        <div>
          <label htmlFor="inspoText" className="mb-1.5 block text-sm font-medium text-ink">
            Tell us your vibe
          </label>
          <textarea
            id="inspoText"
            name="inspoText"
            rows={4}
            placeholder="e.g. Y2K low-rise, but I run cold — lots of layers"
            className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="budget" className="mb-1.5 block text-sm font-medium text-ink">
            Budget
          </label>
          <select
            id="budget"
            name="budget"
            defaultValue=""
            className="w-full cursor-pointer rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
          >
            <option value="">No preference</option>
            {STYLE_REQUEST_BUDGET_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">Categories</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {SELECTED_CATEGORY_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="checkbox"
                  name="categories"
                  value={option.value}
                  checked={selectedCategories.includes(option.value)}
                  onChange={() => toggleCategory(option.value)}
                  className="h-4 w-4 rounded border-border accent-oxblood"
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">Inspo photos (required)</span>
          {/* No `name` — this is a picker only, never read for submission
              (see handleSubmit/handleFilesSelected above). */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleFilesSelected}
            className="hidden"
          />
          <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
            {photos.length > 0 ? "Add more photos" : "Add photos"}
          </Button>
          <p className="mt-1.5 text-xs text-ink-soft">
            Screenshots, Pinterest pins, anything that captures the look. JPEG, PNG, WebP, or GIF,
            up to {MAX_LISTING_PHOTOS}.
          </p>
          <p className="mt-1 text-xs text-ink-soft">Upload up to 10MB per image for best results</p>
          {photoError && <p className="mt-1.5 text-xs text-oxblood">{photoError}</p>}
          {error && <p className="mt-1.5 text-xs text-oxblood">{error}</p>}

          {photos.length > 0 && (
            <p className="mt-1.5 text-xs text-ink-soft">
              {photos.length} photo{photos.length === 1 ? "" : "s"} selected ·{" "}
              {(photos.reduce((sum, photo) => sum + photo.file.size, 0) / (1024 * 1024)).toFixed(1)}MB /{" "}
              {Math.round(MAX_TOTAL_SIZE / (1024 * 1024))}MB
            </p>
          )}

          {photos.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {photos.map((photo, index) => (
                <div key={photo.previewUrl} className="relative aspect-square overflow-hidden rounded-2xl bg-inner">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a freshly-picked local file (blob: URL), not known in advance */}
                  <img src={photo.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => handleRemovePhoto(index)}
                    aria-label="Remove photo"
                    className="absolute right-1 top-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-ink-strong/70 text-white hover:bg-ink-strong"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {state?.error && (
          <p className="rounded-2xl bg-highlight-cream px-4 py-3 text-sm text-ink">{state.error}</p>
        )}

        {/* No pending-state label needed here — the `if (pending)` branch
            above replaces this whole form with the full-screen "Building
            your Lockette bundle…" state before this button could ever
            render disabled/relabeled. */}
        <Button type="submit" className="w-fit">
          Get Styled
        </Button>
      </form>
    </div>
  );
}
