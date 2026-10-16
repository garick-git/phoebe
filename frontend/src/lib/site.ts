import type { Metadata } from "next";

export const SITE_NAME = "Phoebe";

// The site's final public address (DNS is set up Oct 15). Link previews need
// absolute URLs, and canonical links point here even while the app is also
// reachable at the default Amplify URL, so search engines index one address.
export const SITE_URL = "https://phoebe.garickm.com";

export const SITE_TAGLINE = "Live satellite tracker and visible-pass planner";

export const SITE_DESCRIPTION =
  "Watch active satellites move live on a 3D globe, and find out when the ISS and other bright satellites will be visible from your city, and whether clouds will get in the way.";

// Where the live globe puts its search box: an empty slot under the home page's
// pre-rendered heading (filled once the client-only globe has its data).
export const GLOBE_SEARCH_SLOT_ID = "globe-search";

// Where the live globe puts the selected satellite's details: an empty slot in
// the pre-rendered details panel (the placeholder next to it hides itself with
// CSS once the slot has content; see globals.css).
export const GLOBE_DETAIL_SLOT_ID = "globe-details";

export type NavItem = { href: string; label: string };

// trailingSlash is on (next.config.ts), so internal links end in "/".
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Globe" },
  { href: "/tonight/", label: "Tonight" },
  { href: "/about/", label: "About" },
];

// Link preview image (public/og-image.png). Set explicitly on every page: with
// shallow merging, a page that sets its own openGraph would otherwise lose it.
const OG_IMAGE = {
  url: "/og-image.png",
  width: 1200,
  height: 630,
  alt: "Phoebe: a dark night sky with a planet, an amber orbit line and a bright satellite, next to the text “When to look up, and whether you’ll actually see it.”",
};

const openGraphBase = {
  type: "website" as const,
  siteName: SITE_NAME,
  locale: "en_US",
  images: [OG_IMAGE],
};

const twitterBase = { card: "summary_large_image" as const, images: [OG_IMAGE] };

/**
 * Metadata for one page: title, description, canonical URL, and matching
 * Open Graph and Twitter fields.
 *
 * Next.js merges metadata from the layout and the page shallowly: a page that
 * sets `openGraph` replaces the layout's whole `openGraph` object. Building
 * every page's metadata through this one function keeps the shared fields
 * (site name, type, card size) from silently disappearing.
 */
export function pageMetadata({
  title,
  description,
  path,
  isHome = false,
}: {
  title: string;
  description: string;
  path: string;
  isHome?: boolean;
}): Metadata {
  // The layout's title template adds " · Phoebe"; the home title is already complete.
  const fullTitle = isHome ? title : `${title} · ${SITE_NAME}`;
  return {
    title: isHome ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: { ...openGraphBase, title: fullTitle, description, url: path },
    twitter: { ...twitterBase, title: fullTitle, description },
  };
}

/** Defaults for pages that don't set their own (for example the 404 page). */
export const defaultMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} · ${SITE_TAGLINE}`,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    ...openGraphBase,
    title: `${SITE_NAME} · ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    ...twitterBase,
    title: `${SITE_NAME} · ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
};
