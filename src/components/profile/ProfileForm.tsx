"use client";

import { useActionState, useRef, useState } from "react";
import { updateProfile, type ProfileFormState } from "@/app/actions/profile";
import { Button } from "@/components/ui/Button";
import { MAX_AVATAR_BYTES, isAllowedAvatarType } from "@/lib/avatar";

const initialState: ProfileFormState = undefined;

export function ProfileForm({
  defaultValues,
}: {
  defaultValues: {
    username: string;
    displayName: string;
    bio: string;
    avatarUrl: string | null;
  };
}) {
  const [state, formAction, pending] = useActionState(
    updateProfile,
    initialState,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Local object-URL preview of whatever's currently selected — shown
  // immediately on picking a file, well before "Save profile" is clicked
  // and the file is actually uploaded (that upload happens server-side,
  // inside updateProfile, as part of the same submission — see
  // src/app/actions/profile.ts). Starts out as the user's existing avatar,
  // so there's always something sensible to show.
  const [preview, setPreview] = useState<string | null>(defaultValues.avatarUrl);
  const [fileError, setFileError] = useState<string | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!isAllowedAvatarType(file.type)) {
      setFileError("Please choose a JPEG, PNG, WebP, or GIF image.");
      event.target.value = "";
      return;
    }

    if (file.size > MAX_AVATAR_BYTES) {
      setFileError("Image must be 5MB or smaller.");
      event.target.value = "";
      return;
    }

    setFileError(null);
    setPreview(URL.createObjectURL(file));
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-pink-300 bg-white">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- a freshly-picked local file (blob: URL) or an existing Supabase Storage URL, neither known in advance
            <img
              src={preview}
              alt="Profile picture preview"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xs text-ink-soft">No photo</span>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          name="avatarFile"
          accept="image/jpeg,image/png,image/webp,image/gif"
          onChange={handleFileChange}
          className="hidden"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => fileInputRef.current?.click()}
        >
          {defaultValues.avatarUrl ? "Change photo" : "Upload photo"}
        </Button>
        <p className="text-xs text-ink-soft">JPEG, PNG, WebP, or GIF. 5MB max.</p>
        {fileError && <p className="text-xs text-oxblood">{fileError}</p>}
      </div>

      <div>
        <label
          htmlFor="displayName"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          Name
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          defaultValue={defaultValues.displayName}
          className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
        />
        {state?.errors?.displayName?.map((error) => (
          <p key={error} className="mt-1.5 text-xs text-oxblood">
            {error}
          </p>
        ))}
      </div>

      <div>
        <label
          htmlFor="username"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          Username
        </label>
        <input
          id="username"
          name="username"
          type="text"
          placeholder="e.g. thrifty_jamie"
          defaultValue={defaultValues.username}
          className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
        />
        {state?.errors?.username?.map((error) => (
          <p key={error} className="mt-1.5 text-xs text-oxblood">
            {error}
          </p>
        ))}
      </div>

      <div>
        <label
          htmlFor="bio"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
          Bio
        </label>
        <textarea
          id="bio"
          name="bio"
          rows={3}
          placeholder="Tell people a bit about yourself..."
          defaultValue={defaultValues.bio}
          className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-ink focus:border-oxblood focus:outline-none"
        />
      </div>

      {state?.message && (
        <p className="rounded-2xl bg-parchment-deep px-4 py-3 text-sm text-ink">
          {state.message}
        </p>
      )}

      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}
