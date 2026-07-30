export function BrandTile({ name, color }: { name: string; color: string }) {
  return (
    <div
      className="flex aspect-[4/3] w-full items-center justify-center rounded-card p-4 shadow-soft"
      style={{ backgroundColor: color }}
    >
      <span className="font-display text-xl font-semibold italic text-white sm:text-2xl">
        {name}
      </span>
    </div>
  );
}
