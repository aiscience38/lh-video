"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { ChevronsLeft, ChevronsRight, Clapperboard, Image as ImageIcon, Library, Plus, Trash2, Users, Wrench, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, usePathname } from "@/i18n/navigation";

/** Must match the key read by other clients that want to honor the sidebar width. */
export const SIDEBAR_COLLAPSED_KEY = "lh-video.sidebar.collapsed";

type ItemKey = "allMedia" | "characters" | "scenes" | "library" | "tools" | "createTool" | "trash";

interface SidebarItem {
    key: ItemKey;
    href: string;
    icon: typeof ImageIcon;
}

const MEDIA_ITEMS: SidebarItem[] = [
    { key: "allMedia", href: "/", icon: ImageIcon },
    { key: "characters", href: "/library/characters", icon: Users },
    { key: "scenes", href: "/scenes", icon: Clapperboard },
    { key: "library", href: "/library", icon: Library },
];

const TOOL_ITEMS: SidebarItem[] = [
    { key: "tools", href: "/tools", icon: Wrench },
    { key: "createTool", href: "/tools?create=1", icon: Plus },
    { key: "trash", href: "/library/trash", icon: Trash2 },
];

const LIBRARY_CREATE_HREF = "/library/characters?create=1";

const collapsedListeners = new Set<() => void>();

function readCollapsed(): boolean {
    try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"; } catch { return false; }
}

function subscribeCollapsed(listener: () => void): () => void {
    collapsedListeners.add(listener);
    const onStorage = (event: StorageEvent) => { if (event.key === SIDEBAR_COLLAPSED_KEY) listener(); };
    window.addEventListener("storage", onStorage);
    return () => {
        collapsedListeners.delete(listener);
        window.removeEventListener("storage", onStorage);
    };
}

function writeCollapsed(value: boolean): void {
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value)); } catch { /* storage can be blocked */ }
    for (const listener of collapsedListeners) listener();
}

function normalize(pathname: string): string {
    return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** Most specific route wins, so /library/characters never highlights Library too. */
function activeItem(pathname: string, create: string | null): ItemKey | null {
    const path = normalize(pathname);
    if (path === "/") return "allMedia";
    if (path === "/library/characters" || path.startsWith("/library/characters/")) return "characters";
    if (path === "/library/trash") return "trash";
    if (path === "/scenes" || path.startsWith("/scenes/")) return "scenes";
    if (path === "/tools" || path.startsWith("/tools/")) return create === "1" ? "createTool" : "tools";
    if (path === "/library" || path.startsWith("/library/")) return "library";
    return null;
}

function SidebarLink({ item, active, collapsed, onNavigate }: {
    item: SidebarItem;
    active: boolean;
    collapsed: boolean;
    onNavigate?: () => void;
}) {
    const t = useTranslations("sidebar");
    const label = t(`items.${item.key}`);
    const Icon = item.icon;

    return <Link href={item.href} data-testid={`sidebar-${item.key}`} aria-label={label}
        aria-current={active ? "page" : undefined} title={collapsed ? label : undefined} onClick={onNavigate}
        className={`flex h-9 min-w-0 items-center gap-2.5 rounded-lg text-sm font-medium transition-colors ${collapsed ? "w-full justify-center px-0" : "flex-1 px-2.5"} ${active ? "bg-white/[.1] text-white" : "text-muted-foreground hover:bg-white/[.05] hover:text-white"}`}>
        <Icon aria-hidden="true" className={`size-4 shrink-0 ${active ? "text-primary" : ""}`} />
        {collapsed ? null : <span className="truncate">{label}</span>}
    </Link>;
}

function SidebarContent({ collapsed, onToggleCollapsed, showCollapse, onNavigate }: {
    collapsed: boolean;
    onToggleCollapsed: () => void;
    showCollapse: boolean;
    onNavigate?: () => void;
}) {
    const t = useTranslations("sidebar");
    const pathname = usePathname();
    const params = useSearchParams();
    const current = activeItem(pathname, params.get("create"));
    const collapseLabel = t(collapsed ? "expand" : "collapse");
    const groupClass = collapsed ? "sr-only" : "px-2.5 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground";

    return <nav aria-label={t("navigation")} data-testid="sidebar-nav" className="flex min-h-0 flex-1 flex-col p-2">
        <h2 className={groupClass}>{t("groups.media")}</h2>
        <div className="space-y-0.5">
            {MEDIA_ITEMS.map(item => item.key === "library"
                ? <div key={item.key} className="flex items-center gap-1">
                    <SidebarLink item={item} active={current === item.key} collapsed={collapsed} onNavigate={onNavigate} />
                    {collapsed ? null : <Link href={LIBRARY_CREATE_HREF} data-testid="sidebar-library-create"
                        aria-label={t("newCharacter")} title={t("newCharacter")} onClick={onNavigate}
                        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[.08] hover:text-white">
                        <Plus aria-hidden="true" className="size-3.5" />
                    </Link>}
                </div>
                : <SidebarLink key={item.key} item={item} active={current === item.key} collapsed={collapsed} onNavigate={onNavigate} />)}
        </div>

        <div className="mt-auto space-y-0.5 border-t border-white/[.06] pt-2">
            <h2 className={groupClass}>{t("groups.tools")}</h2>
            {TOOL_ITEMS.map(item => <SidebarLink key={item.key} item={item} active={current === item.key} collapsed={collapsed} onNavigate={onNavigate} />)}
            {showCollapse && <button type="button" data-testid="sidebar-collapse" aria-expanded={!collapsed} aria-label={collapseLabel}
                title={collapseLabel} onClick={onToggleCollapsed}
                className={`flex h-9 w-full items-center gap-2.5 rounded-lg text-sm font-medium text-muted-foreground transition-colors hover:bg-white/[.05] hover:text-white ${collapsed ? "justify-center px-0" : "px-2.5"}`}>
                {collapsed ? <ChevronsRight aria-hidden="true" className="size-4 shrink-0" />
                    : <><ChevronsLeft aria-hidden="true" className="size-4 shrink-0" /><span className="truncate">{t("collapse")}</span></>}
            </button>}
        </div>
    </nav>;
}

export function SidebarNav({ mobileOpen, onMobileClose }: { mobileOpen: boolean; onMobileClose: () => void }) {
    const t = useTranslations("sidebar");
    const pathname = usePathname();
    // The server snapshot is expanded so hydration matches the server HTML;
    // React then re-reads localStorage on the client without an effect.
    const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
    const closeButton = useRef<HTMLButtonElement>(null);
    const lastPathname = useRef(pathname);

    useEffect(() => {
        if (!mobileOpen) return;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        closeButton.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onMobileClose();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.body.style.overflow = previousOverflow;
            previous?.focus();
        };
    }, [mobileOpen, onMobileClose]);

    // A route change means the overlay did its job; keep it from covering the new page.
    useEffect(() => {
        if (lastPathname.current === pathname) return;
        lastPathname.current = pathname;
        if (mobileOpen) onMobileClose();
    }, [pathname, mobileOpen, onMobileClose]);

    function toggleCollapsed() {
        writeCollapsed(!collapsed);
    }

    return <>
        <aside id="workspace-sidebar" data-testid="sidebar" data-collapsed={collapsed ? "true" : "false"}
            className={`hidden shrink-0 border-r border-white/[.06] bg-[#0b0c0d] md:flex md:flex-col ${collapsed ? "md:w-[60px]" : "md:w-60"}`}>
            <div className="model-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
                <SidebarContent collapsed={collapsed} onToggleCollapsed={toggleCollapsed} showCollapse />
            </div>
        </aside>

        {mobileOpen && <div data-testid="sidebar-overlay" className="fixed inset-0 z-[60] flex md:hidden">
            <div aria-hidden="true" onClick={onMobileClose} className="absolute inset-0 bg-black/65" />
            <div id="workspace-sidebar-overlay" role="dialog" aria-modal="true" aria-label={t("navigation")}
                className="relative flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-[#0b0c0d] shadow-2xl">
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[.06] px-3">
                    <p className="text-xs font-bold tracking-[.2em] text-white" style={{ fontFamily: "var(--font-display)" }}>LH <span className="text-primary">VIDEO</span></p>
                    <button ref={closeButton} type="button" data-testid="sidebar-overlay-close" onClick={onMobileClose}
                        aria-label={t("close")} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-white/[.08] hover:text-white">
                        <X aria-hidden="true" className="size-4" />
                    </button>
                </div>
                <div className="model-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
                    <SidebarContent collapsed={false} onToggleCollapsed={toggleCollapsed} showCollapse={false} onNavigate={onMobileClose} />
                </div>
            </div>
        </div>}
    </>;
}
