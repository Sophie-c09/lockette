"use client";

import { useActionState, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { X } from "lucide-react";
import { submitStyleMeRequest, type SubmitStyleMeState } from "@/app/actions/style-me";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase/client";
import {
  isAllowedListingPhotoType,
  LISTING_PHOTO_MIME_EXTENSIONS,
  MAX_LISTING_PHOTO_BYTES,
  MAX_LISTING_PHOTOS,
} from "@/lib/listing-photo";
import { STYLE_ME_IMAGES_BUCKET, styleMeImagesFolder } from "@/lib/style-me-photo";

const initialState: SubmitStyleMeState = undefined;

interface PhotoPreview {
  file: File;
  previewUrl: string;
}

export function StyleMeForm() {
  const [state, formAction, pending] = useActionState(submitStyleMeRequest, initialState);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<PhotoPreview[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Same DataTransfer-based sync as StyleRequestForm.tsx — the only way
  // to remove a single file from a multi-file input's read-only FileList.
  function syncFileInput(next: PhotoPreview[]) {
    const dataTransfer = new DataTransfer();
    next.forEach((photo) => dataTransfer.items.add(photo.file));
    if (fileInputRef.current) {
      fileInputRef.current.files = dataTransfer.files;
    }
  }

  function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    setPhotoError(null);
    const next = [...photos];

    for (const file of files) {
      if (!isAllowedListingPhotoType(file.type)) {
        setPhotoError("Photos must be JPEG, PNG, WebP, or GIF.");
        continue;
      }
      if (file.size > MAX_LISTING_PHOTO_BYTES) {
        setPhotoError("Each photo must be 5MB or smaller.");
        continue;
      }
      if (next.length >= MAX_LISTING_PHOTOS) {
        setPhotoError(`You can upload up to ${MAX_LISTING_PHOTOS} photos.`);
        break;
      }
      next.push({ file, previewUrl: URL.createObjectURL(file) });
    }

    setPhotos(next);
    syncFileInput(next);
  }

  function handleRemovePhoto(index: number) {
    setPhotoError(null);
    const next = photos.filter((_, i) => i !== index);
    setPhotos(next);
    syncFileInput(next);
  }

  // Photos are uploaded straight from the browser to Supabase Storage
  // here, BEFORE the Server Action is ever called — not through it. A
  // native <form action={formAction}> submission would have serialized
  // every selected File's raw bytes into the Server Action's own request
  // body, which Next.js caps at 1MB by default; up to MAX_LISTING_PHOTOS
  // (8) photos at up to 5MB each made that limit trivial to exceed. The
  // Server Action now only ever receives a handful of short strings (the
  // request id and the resulting Storage paths), regardless of how large
  // the actual photos are. The "style-me-images" bucket's own RLS insert
  // policy (supabase/schema.sql) already scopes this upload to the
  // signed-in user's own folder, so this needs no service-role client.
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPhotoError(null);

    if (photos.length === 0) {
      setPhotoError("Add at least one photo.");
      return;
    }

    const form = event.currentTarget;
    const formValues = new FormData(form);
    const inspoText = String(formValues.get("inspoText") ?? "");
    const budget = String(formValues.get("budget") ?? "");

    setUploading(true);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setUploading(false);
      setPhotoError("You must be signed in to use Style Me.");
      return;
    }

    // Generated here (not by the database) so the same id can name both
    // the Storage upload folder and the eventual style_me_requests row —
    // the Server Action inserts this id explicitly rather than letting
    // Postgres generate a different one, so the two always match up.
    const requestId = crypto.randomUUID();
    const folder = styleMeImagesFolder(user.id, requestId);
    const uploadedPaths: string[] = [];

    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i].file;
      const extension = LISTING_PHOTO_MIME_EXTENSIONS[photo.type];
      const path = `${folder}/${i}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from(STYLE_ME_IMAGES_BUCKET)
        .upload(path, photo, { contentType: photo.type });

      if (uploadError) {
        if (uploadedPaths.length > 0) {
          await supabase.storage.from(STYLE_ME_IMAGES_BUCKET).remove(uploadedPaths);
        }
        setUploading(false);
        setPhotoError(`Could not upload photo ${i + 1}: ${uploadError.message}`);
        return;
      }

      uploadedPaths.push(path);
    }

    setUploading(false);

    const payload = new FormData();
    payload.set("requestId", requestId);
    payload.set("inspoText", inspoText);
    payload.set("budget", budget);
    payload.set("imagePaths", JSON.stringify(uploadedPaths));

    formAction(payload);
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <h1 className="font-display text-2xl font-semibold text-ink">Style Me</h1>
      <p className="mt-2 text-sm text-ink-soft">
        Send a few photos that capture your style, set a budget, and we&apos;ll surprise you with a
        curated bundle. You won&apos;t see what&apos;s in it until it&apos;s ready.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-5">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">Inspiration photos</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            required
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleFilesSelected}
            className="hidden"
          />
          <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
            {photos.length > 0 ? "Add more photos" : "Add photos"}
          </Button>
          <p className="mt-1.5 text-xs text-ink-soft">
            JPEG, PNG, WebP, or GIF. 5MB max each, up to {MAX_LISTING_PHOTOS} photos.
          </p>
          {photoError && <p className="mt-1.5 text-xs text-oxblood">{photoError}</p>}

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

        <div>
          <label htmlFor="inspoText" className="mb-1.5 block text-sm font-medium text-ink">
            Anything else to know? (optional)
          </label>
          <textarea
            id="inspoText"
            name="inspoText"
            rows={3}
            placeholder="e.g. mostly tops and layers, nothing too bold"
            className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="budget" className="mb-1.5 block text-sm font-medium text-ink">
            Budget ($)
          </label>
          <input
            id="budget"
            name="budget"
            type="number"
            min="0.01"
            step="0.01"
            required
            placeholder="Total for the whole bundle"
            className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
          />
        </div>

        {state?.error && (
          <p className="rounded-2xl bg-highlight-cream px-4 py-3 text-sm text-ink">{state.error}</p>
        )}

        <Button type="submit" disabled={pending || uploading} className="w-fit">
          {uploading ? "Uploading photos…" : pending ? "Sending…" : "Style Me"}
        </Button>
      </form>
    </div>
  );
}
