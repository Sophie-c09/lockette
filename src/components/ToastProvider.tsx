"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface ToastMessage {
  id: number;
  message: string;
}

type ToastContextValue = {
  showToast: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 2500;

let nextToastId = 0;

// No toast/snackbar library exists in this codebase — mirrors
// CartProvider.tsx's exact Context + Provider shape rather than adding a
// dependency for a brief "Listing updated"/"Listing deleted" confirmation.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((message: string) => {
    const id = nextToastId++;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-6">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="rounded-pill bg-ink-strong px-5 py-2.5 text-sm font-medium text-white shadow-card"
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
