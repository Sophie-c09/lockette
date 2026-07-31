import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { CartProvider } from "@/components/CartProvider";
import { ToastProvider } from "@/components/ToastProvider";

const fraunces = Fraunces({
  variable: "--font-display-raw",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
});

const inter = Inter({
  variable: "--font-body-raw",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const SITE_TITLE = "Lockette — Find your next favorite thrifted piece";
const SITE_DESCRIPTION =
  "Swipe through curated secondhand fashion matched to your personal style. Lockette turns thrifting into a personalized discovery experience.";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  keywords: ["Lockette", "secondhand fashion", "thrifting", "sustainable fashion", "resale marketplace", "curated thrift"],
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    siteName: "Lockette",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <CartProvider>
          <ToastProvider>
            <div className="paper-grain" aria-hidden="true" />
            <Nav />
            <main className="flex-1">{children}</main>
            <footer className="border-t border-border/70 px-6 py-12 text-center text-sm text-ink-soft">
              <div className="mx-auto max-w-2xl">
                <h2 className="font-display text-2xl font-semibold text-ink sm:text-3xl">
                  Contact Us
                </h2>
                <p className="mt-3">
                  Need help or have feedback? We&apos;d love to hear from you.
                </p>
                <a
                  href="mailto:support@lockette.org"
                  className="mt-4 inline-block font-medium text-oxblood hover:underline"
                >
                  support@lockette.org
                </a>
                <p className="mt-8">
                  © {new Date().getFullYear()} Lockette. Made for the love of
                  a good find.
                </p>
              </div>
            </footer>
          </ToastProvider>
        </CartProvider>
      </body>
    </html>
  );
}
