"use client";

// In-app account deletion — App Store submission requires this be
// reachable without emailing support (Apple guideline 5.1.1(v)) and that
// it be a real deletion, not mere deactivation. The actual deletion logic
// lives entirely server-side (src/app/actions/account-deletion.ts) — this
// component only collects deliberate confirmation and shows progress/
// error state.
import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useCart } from "@/components/CartProvider";
import { deleteAccount } from "@/app/actions/account-deletion";

const CONFIRMATION_PHRASE = "DELETE";

function DeleteAccountModal({ onClose }: { onClose: () => void }) {
  const { clearCart } = useCart();
  const [confirmationText, setConfirmationText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = confirmationText === CONFIRMATION_PHRASE && !deleting;

  async function handleConfirm() {
    // Guards double submission — a second click while the request is
    // already in flight is a no-op, not a second deletion attempt.
    if (!canConfirm) return;

    setDeleting(true);
    setError(null);

    const result = await deleteAccount(confirmationText);

    if (!result.success) {
      // Recoverable — the modal stays open with a clear error and the
      // confirm button re-enables, rather than silently closing or
      // leaving the user unsure whether anything happened.
      setError(result.error ?? "Something went wrong. Please try again.");
      setDeleting(false);
      return;
    }

    // Session/local state is already gone server-side (deleteAccount
    // signs out internally) — this clears the client-only cart and does
    // a hard navigation (not router.push) so every other piece of
    // client-cached signed-in state is thrown away too, not just soft-
    // navigated past.
    clearCart();
    window.location.assign("/account-deleted");
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-ink-strong/40 sm:items-center"
      onClick={deleting ? undefined : onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-6 sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold text-ink">Delete your account</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            aria-label="Close"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-ink-soft hover:bg-inner disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>

        <p className="mt-4 text-sm text-ink-soft">
          This permanently deletes your profile, Style DNA, likes, saved bundles, style requests, uploaded photos,
          and notifications. <span className="font-semibold text-ink">This cannot be undone.</span>
        </p>
        <p className="mt-2 text-sm text-ink-soft">
          If you have a completed order, a limited transaction record (amount, status, and the identifiers needed
          for refunds or disputes) is retained as required for legal, tax, and fraud-prevention reasons — it will
          no longer be linked to your identity.
        </p>

        <label className="mt-5 flex flex-col gap-1.5 text-xs font-medium text-ink-soft">
          Type DELETE to confirm
          <input
            type="text"
            value={confirmationText}
            onChange={(event) => setConfirmationText(event.target.value)}
            disabled={deleting}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="DELETE"
            className="rounded-md border border-border bg-inner px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        {error && <p className="mt-3 text-sm text-oxblood">{error}</p>}

        <div className="mt-5 flex gap-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={deleting} className="flex-1">
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex-1 !bg-oxblood hover:!bg-oxblood-deep"
          >
            {deleting ? "Deleting…" : "Delete account"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function DeleteAccountSection() {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="flex w-full flex-col items-center gap-3 rounded-card border border-oxblood/30 bg-highlight-cream/40 p-6 text-center">
      <AlertTriangle className="h-6 w-6 text-oxblood" strokeWidth={1.5} />
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-oxblood">Danger zone</p>
      <p className="max-w-[280px] text-sm text-ink-soft">
        Permanently delete your account and personal data. This cannot be undone.
      </p>
      <Button type="button" onClick={() => setModalOpen(true)} className="!bg-oxblood hover:!bg-oxblood-deep">
        Delete Account
      </Button>

      {modalOpen && <DeleteAccountModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}
