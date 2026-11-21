import type { LibraryEntity } from "../types";

/**
 * Every saved media id a library entry contributes. Characters carry reference
 * images directly; scenes carry shot references; storyboards carry one
 * keyframe per panel. Ids are deduplicated in first-seen order so the same
 * asset never fills two capability slots.
 */
export function libraryAssetIds(entity: LibraryEntity): string[] {
    if (entity.kind === "character") return [...new Set(entity.assetIds)];
    const shots = Array.isArray(entity.shots) ? entity.shots : [];
    const ids = shots.flatMap((shot) => {
        if (!shot || typeof shot !== "object") return [];
        const record = shot as Record<string, unknown>;
        const assets = Array.isArray(record.assetIds) ? record.assetIds.filter((id): id is string => typeof id === "string") : [];
        const keyframe = typeof record.keyframeAssetId === "string" ? [record.keyframeAssetId] : [];
        return [...assets, ...keyframe];
    });
    return [...new Set(ids)];
}
