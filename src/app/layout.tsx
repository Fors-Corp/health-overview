import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Health Overview",
  description: "Seguimiento de peso y composición corporal",
};

const SUPPORT_URL = "https://marcfors.com/donate?from=health-overview";

const NAV = [
  { href: "/", label: "Panel" },
  { href: "/measurements", label: "Mediciones" },
  { href: "/upload", label: "Subir informe" },
  { href: "/import-health", label: "Apple Health" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <nav className="border-b border-hairline bg-surface">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap gap-x-5 gap-y-1 px-4 py-3 sm:px-6">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm text-ink-secondary transition-colors hover:text-ink"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
        {children}
        <footer className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
          <a
            href={SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-ink-secondary transition-colors hover:text-ink"
          >
            Apoyar · 1,99 €
          </a>
        </footer>
      </body>
    </html>
  );
}
