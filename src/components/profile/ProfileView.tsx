"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Camera, Gift, Heart, Pencil, Shirt, Sparkles, Wand2 } from "lucide-react";
import type { StyleDna } from "@/lib/style-dna";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { Badge, tagVariantForIndex } from "@/components/ui/Badge";

const EYEBROW =
  "text-xs font-semibold uppercase tracking-[0.2em] text-oxblood";

export function ProfileView({
  displayName,
  username,
  bio,
  initials,
  avatarUrl,
  hasStyleDna,
  styleDna,
  aesthetics,
}: {
  displayName: string;
  username: string;
  bio: string | null;
  initials: string;
  avatarUrl: string | null;
  hasStyleDna: boolean;
  styleDna: StyleDna | null;
  aesthetics: string[];
}) {
  return (
    <div className="min-h-[calc(100vh-137px)] px-6 py-16">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="mx-auto flex w-full max-w-[420px] flex-col items-center gap-10"
      >
        {/* Hero */}
        <div className="flex flex-col items-center text-center">
          <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-2 border-pink-300 bg-white text-2xl font-semibold tracking-tight text-ink">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- Supabase Storage public URL, not a known-in-advance host
              <img
                src={avatarUrl}
                alt={`${displayName}'s profile picture`}
                className="h-full w-full object-cover"
              />
            ) : (
              initials
            )}
          </div>

          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-ink">
            {displayName}
          </h1>
          <p className="mt-1 text-sm tracking-wide text-muted">
            @{username}
          </p>
          <p className="mt-4 max-w-[280px] text-sm text-ink-soft">
            {bio || "No bio yet."}
          </p>

          {/* Action row */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/likes" variant="secondary">
              <Heart className="h-4 w-4" strokeWidth={1.5} />
              Likes
            </LinkButton>
            <LinkButton
              href={hasStyleDna ? "/style-profile" : "/onboarding"}
              variant="secondary"
            >
              <Sparkles className="h-4 w-4" strokeWidth={1.5} />
              {hasStyleDna ? "Style DNA" : "Build DNA"}
            </LinkButton>
            <LinkButton href="/profile/setup" variant="primary">
              <Pencil className="h-4 w-4" strokeWidth={1.5} />
              Edit Profile
            </LinkButton>
          </div>
        </div>

        {/* Style DNA — the main feature */}
        <Card className="w-full p-8 text-center">
          <p className={EYEBROW}>Your Style DNA</p>

          {styleDna ? (
            <>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
                {styleDna.styleName}
              </h2>
              {aesthetics.length > 0 && (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {aesthetics.map((tag, index) => (
                    <Badge key={tag} variant={tagVariantForIndex(index)}>
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              <p className="mx-auto mt-4 max-w-xs text-sm leading-relaxed text-ink-soft">
                {styleDna.description}
              </p>
              <Link
                href="/style-profile"
                className="mt-5 inline-block text-sm font-semibold text-oxblood transition-colors hover:text-teal-deep"
              >
                View full Style DNA →
              </Link>
            </>
          ) : (
            <>
              <p className="mx-auto mt-3 max-w-xs text-sm text-ink-soft">
                You haven&apos;t built your Style DNA yet — a quick quiz
                unlocks your personal aesthetic profile.
              </p>
              <Link
                href="/onboarding"
                className="mt-5 inline-block text-sm font-semibold text-oxblood transition-colors hover:text-teal-deep"
              >
                Build your Style DNA →
              </Link>
            </>
          )}
        </Card>

        {/* Personal Style Request */}
        <Card className="flex w-full flex-col items-center p-8 text-center">
          <Wand2 className="h-6 w-6 text-oxblood" strokeWidth={1.5} />
          <p className={`mt-3 ${EYEBROW}`}>Get Styled</p>
          <p className="mt-2 max-w-[280px] text-sm text-ink-soft">
            Send us your inspiration and we&apos;ll hand-pick a curated bundle just for you.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/style-request" variant="primary">
              Get Styled
            </LinkButton>
            <Link
              href="/my-style-requests"
              className="text-sm font-semibold text-oxblood transition-colors hover:text-teal-deep"
            >
              My requests →
            </Link>
          </div>
        </Card>

        {/* Recreate This Outfit */}
        <Card className="flex w-full flex-col items-center p-8 text-center">
          <Camera className="h-6 w-6 text-oxblood" strokeWidth={1.5} />
          <p className={`mt-3 ${EYEBROW}`}>Recreate This Outfit</p>
          <p className="mt-2 max-w-[280px] text-sm text-ink-soft">
            Upload a photo of an outfit you love and we&apos;ll find real pieces to match it, right
            now.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/recreate-outfit" variant="primary">
              Recreate an Outfit
            </LinkButton>
            <Link
              href="/my-outfits"
              className="text-sm font-semibold text-oxblood transition-colors hover:text-teal-deep"
            >
              My outfits →
            </Link>
          </div>
        </Card>

        {/* Style Me — surprise bundle */}
        <Card className="flex w-full flex-col items-center p-8 text-center">
          <Gift className="h-6 w-6 text-oxblood" strokeWidth={1.5} />
          <p className={`mt-3 ${EYEBROW}`}>Style Me</p>
          <p className="mt-2 max-w-[280px] text-sm text-ink-soft">
            Send a few style photos and a budget — get a surprise bundle, revealed once it&apos;s
            ready.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/style-me" variant="primary">
              Style Me
            </LinkButton>
            <Link
              href="/my-style-me"
              className="text-sm font-semibold text-oxblood transition-colors hover:text-teal-deep"
            >
              My bundles →
            </Link>
          </div>
        </Card>

        {/* Closet — coming soon */}
        <Card className="flex w-full flex-col items-center p-8 text-center">
          <Shirt className="h-6 w-6 text-oxblood" strokeWidth={1.5} />
          <p className={`mt-3 ${EYEBROW}`}>My Closet</p>
          <p className="mt-2 max-w-[280px] text-sm text-ink-soft">
            Coming soon — a digital wardrobe of everything you own and wear.
          </p>
        </Card>
      </motion.div>
    </div>
  );
}
