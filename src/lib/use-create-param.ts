"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { usePathname, useRouter } from "@/i18n/navigation";

/**
 * URL-driven create affordances (`?create=1`). Keeping the query string as the
 * source of truth makes deep links work without an effect that mirrors it into
 * component state, and closing the dialog clears the parameter again.
 */
export function useCreateParam(): { open: boolean; close: () => void } {
    const params = useSearchParams();
    const pathname = usePathname();
    const router = useRouter();
    const open = params.get("create") === "1";
    const close = useCallback(() => {
        if (!open) return;
        const next = new URLSearchParams(params.toString());
        next.delete("create");
        const query = next.toString();
        router.replace(query ? `${pathname}?${query}` : pathname);
    }, [open, params, pathname, router]);
    return { open, close };
}
