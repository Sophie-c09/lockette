import Image from "next/image";

export function MoodCard({
  image,
  name,
  description,
}: {
  image: string;
  name: string;
  description?: string;
}) {
  return (
    <div className="group relative aspect-[3/4] w-full overflow-hidden rounded-card shadow-soft">
      <Image
        src={image}
        alt={name}
        fill
        className="object-cover transition-transform duration-500 group-hover:scale-105"
        sizes="(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 45vw"
      />
      <div className="absolute inset-x-0 bottom-0 bg-darkgreen/55 p-4">
        <h3 className="font-display text-lg font-semibold text-white sm:text-xl">
          {name}
        </h3>
        {description && (
          <p className="mt-1 text-xs text-white/80 sm:text-sm">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
