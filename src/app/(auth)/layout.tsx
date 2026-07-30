import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-137px)] items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
