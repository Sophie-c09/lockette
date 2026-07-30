// Shared by Nav and CartNavLink so active-state matching stays consistent:
// a route is "active" for its own path and any nested path beneath it
// (e.g. /profile/setup, /cart/item123, /discover/item123).
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
