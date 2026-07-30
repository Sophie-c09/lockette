"use client";

import { motion } from "motion/react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Button, LinkButton } from "@/components/ui/Button";

export function StepComplete({
  status,
  errorMessage,
  onRetry,
}: {
  status: "saving" | "success" | "error";
  errorMessage: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
      {status === "saving" && (
        <>
          <Loader2 className="h-10 w-10 animate-spin text-oxblood" />
          <p className="mt-6 font-display text-xl font-semibold text-ink">
            Saving your style profile…
          </p>
        </>
      )}

      {status === "success" && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 22 }}
          className="flex flex-col items-center rounded-card bg-highlight-cream px-10 py-12"
        >
          <CheckCircle2 className="h-14 w-14 text-olive" strokeWidth={1.5} />
          <h1 className="mt-6 font-display text-3xl font-semibold text-ink">
            You&apos;re all set!
          </h1>
          <p className="mt-3 text-ink-soft">
            Your style profile is saved. Let&apos;s see what it says about
            you.
          </p>
          <LinkButton
            href="/style-profile"
            className="mt-8 px-7 py-3.5 text-base"
          >
            Reveal my style DNA
          </LinkButton>
        </motion.div>
      )}

      {status === "error" && (
        <>
          <AlertCircle className="h-12 w-12 text-oxblood" strokeWidth={1.5} />
          <p className="mt-6 font-display text-xl font-semibold text-ink">
            Something went wrong
          </p>
          <p className="mt-2 text-sm text-ink-soft">{errorMessage}</p>
          <Button onClick={onRetry} className="mt-6">
            Try again
          </Button>
        </>
      )}
    </div>
  );
}
