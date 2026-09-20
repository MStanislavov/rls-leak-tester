/** Navigation, outbound links and the one-line description of the app shell. */

/** The one-line description of the brief: page metadata, README and package.json use the same. */
export const SITE_DESCRIPTION =
  "Test whether your Postgres and Supabase row-level security policies actually isolate users and tenants, in your browser, with a CI-ready proof.";

/** The owner's public GitHub repository (its name differs from the package name on purpose). */
export const REPO_URL = "https://github.com/MStanislavov/rls-leak-tester";

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /**
   * The lab pulls in the editor and, once it runs, Postgres. A link to it is never prefetched, so
   * a page that only links there requests nothing of it (brief 3.3: the landing page stays light).
   */
  readonly prefetch: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/lab", label: "Lab", prefetch: false },
  { href: "/docs", label: "Docs", prefetch: true },
];

/** True when `pathname` is the item's page or a page below it. `/` matches only itself. */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
