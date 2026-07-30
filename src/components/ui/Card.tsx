import type { HTMLAttributes, ReactNode } from "react";

export function Card({
  children,
  className = "",
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-card border border-border bg-surface shadow-soft transition-all duration-200 ease-in-out hover:-translate-y-0.5 hover:shadow-card ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
