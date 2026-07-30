"use client";

import { useEffect, useRef, type ComponentProps } from "react";
import Image from "next/image";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { Badge, tagVariantForIndex } from "@/components/ui/Badge";
import type { ClothingItem } from "@/lib/mock-clothing";

const SWIPE_THRESHOLD = 120;
const SWIPE_VELOCITY_THRESHOLD = 500;
const EXIT_DISTANCE = 600;
const DOUBLE_TAP_WINDOW = 300;

type DragEndHandler = NonNullable<ComponentProps<typeof motion.div>["onDragEnd"]>;

export function ClothingCard({
  item,
  active,
  stackIndex,
  exitDirection,
  onSwiped,
  onExitComplete,
  onSelect,
  onDoubleTap,
}: {
  item: ClothingItem;
  active: boolean;
  stackIndex: number;
  exitDirection: "left" | "right" | null;
  onSwiped: (direction: "left" | "right") => void;
  onExitComplete?: () => void;
  onSelect?: (item: ClothingItem) => void;
  onDoubleTap?: (item: ClothingItem, imageRect?: DOMRect) => void;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-260, 260], [-16, 16]);
  const saveOpacity = useTransform(x, [20, 120], [0, 1]);
  const passOpacity = useTransform(x, [-120, -20], [1, 0]);

  useEffect(() => {
    if (!exitDirection) return;

    const target = exitDirection === "right" ? EXIT_DISTANCE : -EXIT_DISTANCE;
    const controls = animate(x, target, {
      type: "spring",
      stiffness: 260,
      damping: 24,
      onComplete: onExitComplete,
    });

    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitDirection]);

  const lastTapAtRef = useRef(0);
  const imageWrapperRef = useRef<HTMLDivElement>(null);

  function handleTap() {
    if (!active) return;
    // A genuine tap leaves the card at rest. Guard against firing
    // select/superlike off a tap that lands mid-drag or during the
    // spring-back/exit flight, where x is still away from 0.
    if (Math.abs(x.get()) > 1) return;

    const now = Date.now();
    if (now - lastTapAtRef.current < DOUBLE_TAP_WINDOW) {
      lastTapAtRef.current = 0;
      onDoubleTap?.(item, imageWrapperRef.current?.getBoundingClientRect());
      return;
    }

    lastTapAtRef.current = now;
    onSelect?.(item);
  }

  const handleDragEnd: DragEndHandler = (_event, info) => {
    if (!active) return;

    const passedDistance = info.offset.x > SWIPE_THRESHOLD;
    const passedVelocity = info.velocity.x > SWIPE_VELOCITY_THRESHOLD;
    const skippedDistance = info.offset.x < -SWIPE_THRESHOLD;
    const skippedVelocity = info.velocity.x < -SWIPE_VELOCITY_THRESHOLD;

    if (passedDistance || passedVelocity) {
      onSwiped("right");
    } else if (skippedDistance || skippedVelocity) {
      onSwiped("left");
    } else {
      animate(x, 0, { type: "spring", stiffness: 300, damping: 24 });
    }
  };

  return (
    <motion.div
      className="absolute inset-0 touch-none"
      style={{ x, rotate, zIndex: 10 - stackIndex }}
      animate={
        active
          ? { scale: 1, y: 0 }
          : { scale: 1 - stackIndex * 0.045, y: stackIndex * 14 }
      }
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      drag={active ? "x" : false}
      dragElastic={0.6}
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={handleDragEnd}
      whileTap={active ? { cursor: "grabbing" } : undefined}
      onTap={handleTap}
      onFocus={() => onSelect?.(item)}
      tabIndex={active ? 0 : -1}
      role="button"
      aria-label={`View items similar to ${item.name}`}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div
          ref={imageWrapperRef}
          className="relative h-3/5 shrink-0 bg-parchment-deep"
        >
          <Image
            src={item.image}
            alt={item.name}
            fill
            draggable={false}
            className="pointer-events-none select-none object-cover"
            sizes="(min-width: 640px) 384px, 100vw"
          />

          <motion.span
            style={{ opacity: saveOpacity }}
            className="absolute left-5 top-5 -rotate-12 rounded-lg border-4 border-olive bg-white/85 px-3 py-1 text-xl font-black uppercase tracking-wider text-olive"
          >
            Save
          </motion.span>
          <motion.span
            style={{ opacity: passOpacity }}
            className="absolute right-5 top-5 rotate-12 rounded-lg border-4 border-oxblood bg-white/85 px-3 py-1 text-xl font-black uppercase tracking-wider text-oxblood"
          >
            Pass
          </motion.span>

          <span className="absolute bottom-3 right-3 rounded-pill bg-darkgreen/45 px-2.5 py-1 text-xs font-medium text-white">
            {item.source}
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-2 p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-display text-lg font-semibold leading-tight text-ink">
              {item.name}
            </h3>
            <span className="shrink-0 font-display text-lg font-semibold text-oxblood">
              ${item.price}
            </span>
          </div>
          <p className="text-sm text-ink-soft">
            {item.brand} · Size {item.size}
          </p>
          <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
            {item.aesthetics.map((tag, index) => (
              <Badge key={tag} variant={tagVariantForIndex(index)}>
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
