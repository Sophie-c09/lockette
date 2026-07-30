"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { MAX_AVATAR_BYTES, AVATAR_MIME_EXTENSIONS, isAllowedAvatarType } from "@/lib/avatar";

const ProfileSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, { error: "Username must be at least 3 characters." })
    .max(30, { error: "Username must be 30 characters or fewer." })
    .regex(/^[a-z0-9_]+$/, {
      error: "Use lowercase letters, numbers, and underscores only.",
    }),
  displayName: z
    .string()
    .trim()
    .min(2, { error: "Name must be at least 2 characters." }),
  bio: z.string().trim().max(280),
});

export type ProfileFormState =
  | {
      errors?: Record<string, string[]>;
      message?: string;
    }
  | undefined;

export async function updateProfile(
  _prevState: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { message: "You must be signed in to update your profile." };
  }

  const validatedFields = ProfileSchema.safeParse({
    username: formData.get("username"),
    displayName: formData.get("displayName"),
    bio: formData.get("bio"),
  });

  if (!validatedFields.success) {
    return {
      errors: validatedFields.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    };
  }

  const { username, displayName, bio } = validatedFields.data;

  // avatarFile is only present when the user actually picked a new photo
  // this submission (see ProfileForm.tsx) — an empty file input still
  // submits a zero-byte File with no name, so `size > 0` is what actually
  // distinguishes "a new photo was chosen" from "nothing changed".
  const avatarFile = formData.get("avatarFile");
  let avatarUrl: string | null = null;

  if (avatarFile instanceof File && avatarFile.size > 0) {
    // Never trust the client's own validation (ProfileForm.tsx does the
    // same checks purely for instant feedback) — this is the check that
    // actually matters, backed further by the "avatars" bucket's own
    // file_size_limit/allowed_mime_types in supabase/schema.sql.
    if (!isAllowedAvatarType(avatarFile.type)) {
      return { message: "Please choose a JPEG, PNG, WebP, or GIF image." };
    }

    if (avatarFile.size > MAX_AVATAR_BYTES) {
      return { message: "Image must be 5MB or smaller." };
    }

    // Fixed filename per user (not the original upload's name) — combined
    // with upsert below, this is what makes "replace an existing profile
    // picture" just work: the new upload overwrites the same storage
    // object rather than accumulating a new one per upload.
    const extension = AVATAR_MIME_EXTENSIONS[avatarFile.type];
    const path = `${user.id}/profile-image.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(path, avatarFile, { upsert: true, contentType: avatarFile.type });

    if (uploadError) {
      return { message: `Could not upload your photo: ${uploadError.message}` };
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from("avatars").getPublicUrl(path);

    // Cache-bust: the storage path never changes on replace (same fixed
    // filename above), so without this, a browser that already cached the
    // old image at that exact URL would keep showing it after a genuine
    // replace.
    avatarUrl = `${publicUrl}?updated=${Date.now()}`;
  }

  // Identity data only — fashion preferences live on style_profiles and are
  // written exclusively by the /onboarding flow (src/app/actions/onboarding.ts).
  const { data, error } = await supabase
    .from("profiles")
    .update({
      username,
      display_name: displayName,
      bio: bio || null,
      // Only touched when a new photo was actually uploaded this
      // submission — omitting the key entirely (rather than setting it to
      // null) leaves whatever avatar_url already exists untouched when the
      // user is just editing their name/username/bio.
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { errors: { username: ["That username is already taken."] } };
    }
    return { message: error.message };
  }

  if (!data) {
    return { message: "Your profile couldn't be saved. Please try again." };
  }

  redirect("/profile");
}
