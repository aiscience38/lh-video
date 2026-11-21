"use client";

import type { ReactNode } from "react";
import { Library } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

export function ScenesShell({ title, subtitle, actions, children }: {
    title: string;
    subtitle: string;
    actions?: ReactNode;
    children: ReactNode;
}) {
    const t = useTranslations("scenes");

    return <div className="flex h-full min-h-0 flex-col">
        <div className="model-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-[1200px] space-y-6 px-4 py-6 sm:px-7 sm:py-9 lg:px-10">
                <header className="max-w-2xl">
                    <p className="mb-3 text-[11px] font-bold tracking-[.2em] text-primary">{t("eyebrow")}</p>
                    <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
                </header>
                {actions && <div className="flex flex-wrap items-center justify-between gap-3">{actions}</div>}
                {children}
                <Link href="/library" className="inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground">
                    <Library aria-hidden="true" className="size-4" />{t("backToLibrary")}
                </Link>
            </div>
        </div>
    </div>;
}
