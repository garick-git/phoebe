"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { NAV_ITEMS, SITE_NAME } from "@/lib/site";
import AskPhoebeDialog from "./AskPhoebeDialog";
import { ChatIcon, GlobeIcon, InfoIcon, MoonIcon, PhoebeMark } from "./icons";

const TAB_ICONS: Record<string, typeof GlobeIcon> = {
  "/": GlobeIcon,
  "/tonight/": MoonIcon,
  "/about/": InfoIcon,
};

// "/tonight" and "/tonight/" are the same page.
function samePath(a: string, b: string) {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return strip(a) === strip(b);
}

/**
 * Site header (desktop), bottom tab bar (phones), and the Ask Phoebe dialog.
 * A client component because it reads the current path (to mark the active
 * link) and opens the dialog; the pages themselves stay server components.
 */
export default function SiteChrome() {
  const pathname = usePathname();
  const askRef = useRef<HTMLDialogElement>(null);
  const openAsk = () => askRef.current?.showModal();

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md text-lg font-semibold tracking-tight"
          >
            <PhoebeMark className="size-6 text-accent" />
            {SITE_NAME}
          </Link>

          <nav aria-label="Main" className="hidden sm:block">
            <ul className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const active = samePath(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`rounded-md px-3 py-2 text-sm transition-colors ${
                        active
                          ? "bg-surface font-medium text-accent"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <button
            type="button"
            onClick={openAsk}
            aria-haspopup="dialog"
            className="ml-auto hidden items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent/90 sm:inline-flex"
          >
            <ChatIcon className="size-4" />
            Ask Phoebe
          </button>
        </div>
      </header>

      {/* Phones: a bottom tab bar within thumb reach (Tonight is used outside, one-handed). */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
      >
        <ul className="grid grid-cols-4">
          {NAV_ITEMS.slice(0, 2).map((item) => (
            <TabLink key={item.href} item={item} pathname={pathname} />
          ))}
          <li>
            <button
              type="button"
              onClick={openAsk}
              aria-haspopup="dialog"
              className="flex min-h-14 w-full flex-col items-center justify-center gap-1 text-xs text-muted"
            >
              <ChatIcon className="size-6 text-accent" />
              Ask
            </button>
          </li>
          {NAV_ITEMS.slice(2).map((item) => (
            <TabLink key={item.href} item={item} pathname={pathname} />
          ))}
        </ul>
      </nav>

      <AskPhoebeDialog ref={askRef} />
    </>
  );
}

function TabLink({
  item,
  pathname,
}: {
  item: (typeof NAV_ITEMS)[number];
  pathname: string;
}) {
  const active = samePath(pathname, item.href);
  const Icon = TAB_ICONS[item.href] ?? GlobeIcon;
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-14 flex-col items-center justify-center gap-1 text-xs ${
          active ? "font-semibold text-accent" : "text-muted"
        }`}
      >
        <Icon className="size-6" />
        {/* Active state also shown by weight and an underline, not color alone. */}
        <span className={active ? "underline decoration-2 underline-offset-4" : undefined}>
          {item.label}
        </span>
      </Link>
    </li>
  );
}
