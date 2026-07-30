import type { ReactNode } from "react";
import { AppTabBar } from "@/components/AppTabBar";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="pb-20">{children}</div>
      <AppTabBar />
    </>
  );
}
