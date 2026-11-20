"use client";

import type { ReactNode } from "react";
import { Clapperboard, LayoutGrid, PanelsTopLeft, Users } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

export type LibrarySection = "overview" | "characters" | "scenes" | "storyboards";

const SECTIONS: Array<{ key: LibrarySection; href: string; icon: typeof LayoutGrid }> = [
    { key: "overview", href: "/library", icon: LayoutGrid },
    { key: "characters", href: "/library/characters", icon: Users },
    { key: "scenes", href: "/library/scenes", icon: Clapperboard },
    { key: "storyboards", href: "/library/storyboards", icon: PanelsTopLeft },
];

export function LibraryShell({ active, title, subtitle, children }: {
    active: LibrarySection;
    title: string;
    subtitle: string;
    children: ReactNode;
}) {
    const t = useTranslations("library");
    const pathname = usePathname();

    return <div className="flex h-full min-h-0 flex-col">
        <div className="model-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-[1200px] space-y-6 px-4 py-6 sm:px-7 sm:py-9 lg:px-10">
                <header className="max-w-2xl">
                    <p className="mb-3 text-[11px] font-bold tracking-[.2em] text-primary">{t("eyebrow")}</p>
                    <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
                </header>
                <nav aria-label={t("tabs.label")} className="flex flex-wrap gap-1 rounded-xl border border-white/10 bg-white/[.02] p-1">
                    {SECTIONS.map(({ key, href, icon: Icon }) => {
                        const selected = key === active && (pathname === href || pathname.startsWith(`${href}/`));
                        return <Link key={key} href={href} data-testid={`library-tab-${key}`} aria-current={selected ? "page" : undefined}
                            className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${selected ? "bg-white/[.1] text-white" : "text-muted-foreground hover:bg-white/[.05] hover:text-foreground"}`}>
                            <Icon aria-hidden="true" className={`size-4 ${selected ? "text-primary" : ""}`} />
                            {t(`tabs.${key}`)}
                        </Link>;
                    })}
                </nav>
                {children}
            </div>
        </div>
    </div>;
}
