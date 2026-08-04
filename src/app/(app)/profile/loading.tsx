import { Card } from "@/components/ui/Card";

// Pre-launch polish fix (item 5) — /profile had no loading.tsx at all (a
// blank page during its two parallel Supabase queries); shaped like
// ProfileView's own avatar/name/bio header followed by its Card sections.
export default function ProfileLoading() {
  return (
    <div className="min-h-[calc(100vh-137px)] px-6 py-16">
      <div className="mx-auto flex w-full max-w-[420px] flex-col items-center gap-10">
        <div className="flex flex-col items-center text-center">
          <div className="h-28 w-28 animate-pulse rounded-full bg-inner" />
          <div className="mt-5 h-6 w-32 animate-pulse rounded bg-inner" />
          <div className="mt-2 h-4 w-24 animate-pulse rounded bg-inner" />
          <div className="mt-4 h-4 w-48 animate-pulse rounded bg-inner" />
        </div>

        <Card className="w-full p-8 text-center">
          <div className="mx-auto h-6 w-40 animate-pulse rounded bg-inner" />
          <div className="mx-auto mt-4 h-4 w-56 animate-pulse rounded bg-inner" />
        </Card>

        <Card className="flex w-full flex-col items-center p-8 text-center">
          <div className="h-6 w-6 animate-pulse rounded-full bg-inner" />
          <div className="mt-3 h-4 w-48 animate-pulse rounded bg-inner" />
        </Card>
      </div>
    </div>
  );
}
