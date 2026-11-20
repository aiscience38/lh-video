import type { Metadata, Viewport } from "next";
import { Manrope, Playfair_Display } from "next/font/google";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { getMessages, getTranslations } from "next-intl/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import "@/app/globals.css";
import { locales, openGraphLocales } from "@/i18n/locales";

export const viewport: Viewport = { colorScheme: "dark" };

const manrope = Manrope({
    subsets: ["latin"],
    variable: "--font-manrope",
    weight: ["400", "500", "600", "700", "800"],
});

const playfair = Playfair_Display({
    subsets: ["latin"],
    variable: "--font-playfair",
    weight: ["500", "600", "700"],
});

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
    const { locale } = await params;
    if (!hasLocale(locales, locale)) notFound();
    const t = await getTranslations({ locale, namespace: "metadata" });
    return {
        metadataBase: new URL("https://openhiggs.techbe.me"),
        title: { default: t("title"), template: "%s | LH Video" },
        description: t("description"), keywords: t("keywords").split(","),
        authors: [{ name: "TechBe", url: "https://techbe.me" }], creator: "TechBe", applicationName: "LH Video",
        alternates: { canonical: `/${locale}`, languages: Object.fromEntries(locales.map(code => [code, `/${code}`])) },
        manifest: `/${locale}/manifest.webmanifest`,
        openGraph: {
            type: "website", url: `/${locale}`, siteName: "LH Video", title: t("title"), description: t("socialDescription"),
            locale: openGraphLocales[locale], alternateLocale: locales.filter(code => code !== locale).map(code => openGraphLocales[code]),
            images: [{ url: "/og-image.png", width: 1200, height: 630, alt: t("imageAlt") }],
        },
        twitter: { card: "summary_large_image", title: t("title"), description: t("socialDescription"), images: ["/og-image.png"] },
        icons: { icon: "/icon.svg" },
    };
}

export default async function LocaleLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    if (!hasLocale(routing.locales, locale)) notFound();
    const messages = await getMessages();

    return (
        <html lang={locale} className="dark">
            <head>
                {/* The workspace is already dark; prevent extension rewrites before hydration. */}
                <meta name="darkreader-lock" />
            </head>
            <body className={`${manrope.variable} ${playfair.variable}`}>
                <NextIntlClientProvider messages={messages}>
                    <TooltipProvider><WorkspaceShell>{children}</WorkspaceShell></TooltipProvider>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}
