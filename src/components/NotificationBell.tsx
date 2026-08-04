"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import {
  getNotificationsWithUnreadCount,
  markNotificationRead,
  type Notification,
} from "@/lib/notifications";

const POLL_INTERVAL_MS = 30000;

function formatElapsedSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Polls rather than subscribing to Realtime — simple, no extra
// infrastructure, and "without needing to refresh the page" doesn't
// require sub-second latency for an order-status update.
export function NotificationBell({
  initialNotifications,
  initialUnreadCount,
}: {
  initialNotifications: Notification[];
  initialUnreadCount: number;
}) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(initialNotifications);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const interval = setInterval(async () => {
      const { notifications: list, unreadCount: count } = await getNotificationsWithUnreadCount();
      setNotifications(list);
      setUnreadCount(count);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleOpenDropdown() {
    const next = !open;
    setOpen(next);
    if (next) {
      // Refresh on open too, not just on the poll interval, so a bell
      // click always shows the latest state.
      const { notifications: list, unreadCount: count } = await getNotificationsWithUnreadCount();
      setNotifications(list);
      setUnreadCount(count);
    }
  }

  async function handleNotificationClick(notification: Notification) {
    setOpen(false);

    if (!notification.read) {
      setNotifications((prev) =>
        prev.map((item) => (item.id === notification.id ? { ...item, read: true } : item)),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      markNotificationRead(notification.id).catch(() => {});
    }

    if (notification.order_id) {
      router.push(`/orders/${notification.order_id}`);
    } else if (notification.type === "style_request_completed") {
      router.push("/my-style-requests");
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleOpenDropdown}
        aria-label="Notifications"
        aria-expanded={open}
        className="relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-ink-soft transition-colors hover:text-ink"
      >
        <Bell className="h-5 w-5" strokeWidth={1.75} />
        {unreadCount > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-pill bg-oxblood px-1 text-[10px] font-semibold leading-none text-parchment">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-80 max-w-[90vw] rounded-card border border-border bg-surface shadow-card">
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="p-4 text-center text-sm text-ink-soft">No notifications yet.</p>
            ) : (
              notifications.map((notification) => (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => handleNotificationClick(notification)}
                  className={`block w-full cursor-pointer border-b border-border/60 p-3 text-left last:border-b-0 hover:bg-inner ${
                    notification.read ? "" : "bg-highlight-cream"
                  }`}
                >
                  <p className="text-sm font-semibold text-ink">{notification.title}</p>
                  <p className="mt-0.5 text-xs text-ink-soft">{notification.message}</p>
                  <p className="mt-1 text-[11px] text-ink-soft/70">
                    {formatElapsedSince(notification.created_at)}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
