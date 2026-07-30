"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";

// Generic swipe-gesture wrapper — extracted from match/MatchView.tsx's
// former private SwipeCard so the admin pending-review queue can reuse the
// exact same drag/exit-animation/tap-detection mechanics instead of a
// second, drifting copy (see AdminPendingSwipeView.tsx). Content-agnostic:
// callers render their own card markup via `children`, keyed off the
// dragState this component tracks internally (isTop/translateX), same as
// MatchView's own LIKE/SKIP badges used to reach into that local state
// directly. Everything else — stack offset/scale for non-top cards, exit
// distance, tap vs double-tap detection — is unchanged from MatchView's
// original implementation.
export type SwipeDirection = "left" | "right";

// Shared "how many cards deep" default for a swipe stack — both
// MatchView and AdminPendingSwipeView slice their own queue to this depth.
export const SWIPE_STACK_SIZE = 3;

const SWIPE_THRESHOLD = 100;
const EXIT_DISTANCE = 600;
// A tap that moves less than this counts as a genuine tap rather than an
// aborted drag; two of those within the window count as a double tap.
const TAP_MOVE_THRESHOLD = 10;
const DOUBLE_TAP_WINDOW = 300;

export interface SwipeCardDragState {
  isTop: boolean;
  translateX: number;
}

export function SwipeableCard({
  stackIndex,
  exitDirection,
  onSwiped,
  onExitComplete,
  onTap,
  onDoubleTap,
  doubleTapRectRef,
  children,
}: {
  stackIndex: number;
  exitDirection: SwipeDirection | null;
  onSwiped: (direction: SwipeDirection) => void;
  onExitComplete: () => void;
  // Both optional — a caller with no tap/double-tap behavior (e.g. a
  // review queue that's swipe-only) just omits them.
  onTap?: () => void;
  onDoubleTap?: (imageRect?: DOMRect) => void;
  // Caller-owned ref to whatever element onDoubleTap's rect should be
  // measured from (MatchView attaches this to just its image area, not the
  // whole card, so the fly-to-cart animation starts from the photo —
  // this component only reads it, never creates or attaches it itself).
  doubleTapRectRef?: RefObject<HTMLDivElement | null>;
  children: (state: SwipeCardDragState) => ReactNode;
}) {
  const isTop = stackIndex === 0;
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [pointerId, setPointerId] = useState<number | null>(null);
  const lastTapAtRef = useRef(0);
  // Holds the pending "was this actually just a single tap" timer — a
  // qualifying tap doesn't fire immediately, since a second tap arriving
  // within DOUBLE_TAP_WINDOW should double-tap instead (see endDrag
  // below), not also fire the single-tap handler.
  const tapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (tapTimeoutRef.current) clearTimeout(tapTimeoutRef.current);
    };
  }, []);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isTop || exitDirection) return;
    setDragging(true);
    setPointerId(event.pointerId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || event.pointerId !== pointerId) return;
    setDragX((current) => current + event.movementX);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || event.pointerId !== pointerId) return;
    setDragging(false);
    setPointerId(null);

    if (Math.abs(dragX) > SWIPE_THRESHOLD) {
      onSwiped(dragX > 0 ? "right" : "left");
      return;
    }

    if (Math.abs(dragX) < TAP_MOVE_THRESHOLD) {
      const now = Date.now();
      if (now - lastTapAtRef.current < DOUBLE_TAP_WINDOW) {
        // Second tap of a double-tap: cancel the first tap's pending
        // single-tap callback and fire the double-tap one instead.
        if (tapTimeoutRef.current) {
          clearTimeout(tapTimeoutRef.current);
          tapTimeoutRef.current = null;
        }
        lastTapAtRef.current = 0;
        onDoubleTap?.(doubleTapRectRef?.current?.getBoundingClientRect());
        setDragX(0);
        return;
      }

      lastTapAtRef.current = now;
      // Wait out the double-tap window before treating this as a genuine
      // single tap — otherwise the first tap of what turns into a
      // double-tap would fire before the second tap ever lands.
      tapTimeoutRef.current = setTimeout(() => {
        tapTimeoutRef.current = null;
        onTap?.();
      }, DOUBLE_TAP_WINDOW);
    }

    setDragX(0);
  }

  const isExiting = exitDirection !== null;
  const translateX = isExiting
    ? exitDirection === "right"
      ? EXIT_DISTANCE
      : -EXIT_DISTANCE
    : dragX;
  const rotate = translateX / 24;

  const transform = isTop
    ? `translateX(${translateX}px) rotate(${rotate}deg)`
    : `translateY(${stackIndex * 10}px) scale(${1 - stackIndex * 0.04})`;

  return (
    <div
      className="absolute inset-0"
      style={{
        transform,
        opacity: isTop ? Math.max(1 - Math.abs(translateX) / (EXIT_DISTANCE * 1.5), 0) : 1,
        transition: dragging ? "none" : "transform 300ms ease-out, opacity 300ms ease-out",
        touchAction: "pan-y",
        zIndex: SWIPE_STACK_SIZE - stackIndex,
      }}
      onTransitionEnd={() => {
        if (isExiting) onExitComplete();
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {children({ isTop, translateX })}
    </div>
  );
}
