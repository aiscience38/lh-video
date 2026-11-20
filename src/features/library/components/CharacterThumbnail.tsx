"use client";

import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { libraryAssetUrl } from "../lib/asset-url";

export function CharacterThumbnail({ assetId, name, className = "" }: { assetId?: string; name: string; className?: string }) {
    const [failed, setFailed] = useState(false);
    const url = assetId ? libraryAssetUrl(assetId) : null;
    if (!url || failed) {
        return <div className={`grid place-items-center bg-white/[.03] text-muted-foreground ${className}`}>
            <ImageIcon aria-hidden="true" className="size-6" />
        </div>;
    }
    return <div className={`overflow-hidden bg-black/30 ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" />
    </div>;
}
