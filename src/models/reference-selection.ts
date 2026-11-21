/**
 * Library reference resolution — shared, side-effect-free logic that maps saved
 * library assets (characters, scenes, storyboards) onto the media slots of the
 * capability currently selected in the composer.
 *
 * The rule is explicit: every asset either lands in a slot or is returned as a
 * refusal with a reason the UI can phrase in plain language. There are no
 * silent drops.
 */

export type ReferenceLibraryKind = "character" | "scene" | "storyboard";

/** One selected library entry and the asset ids it contributes. */
export interface ReferenceSource {
    entityId: string;
    entityName: string;
    libraryKind: ReferenceLibraryKind;
    assetIds: string[];
}

/** The subset of MediaSlotCapability this resolver needs. */
export interface ReferenceSlot {
    id: string;
    label: string;
    kind: "image" | "video" | "audio";
    multiple?: boolean;
    max_count?: number;
}

export type ReferenceRefusalReason = "unsupported" | "capacity" | "invalid" | "duplicate";

export interface ReferenceAssignment {
    slotId: string;
    slotLabel: string;
    assetId: string;
    entityId: string;
    entityName: string;
}

export interface ReferenceRefusal {
    assetId: string;
    entityId: string;
    entityName: string;
    reason: ReferenceRefusalReason;
}

export interface ReferenceResolution {
    assignments: ReferenceAssignment[];
    refused: ReferenceRefusal[];
}

/** Where the UI gets a plain-language sentence for each refusal. */
export interface ReferenceRefusalCopy {
    key: "refusalUnsupported" | "refusalCapacity" | "refusalInvalid" | "refusalDuplicate";
    values: Record<string, string>;
}

export function referenceRefusalCopy(refusal: ReferenceRefusal, capabilityLabel: string): ReferenceRefusalCopy {
    switch (refusal.reason) {
        case "unsupported":
            return { key: "refusalUnsupported", values: { capability: capabilityLabel } };
        case "capacity":
            return { key: "refusalCapacity", values: { name: refusal.entityName, capability: capabilityLabel } };
        case "invalid":
            return { key: "refusalInvalid", values: { name: refusal.entityName, asset: refusal.assetId } };
        case "duplicate":
            return { key: "refusalDuplicate", values: { name: refusal.entityName } };
    }
}

/** Same shape as the library contract's asset id: safe as a path segment. */
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Dedicated frame and mask roles are filled last, after ordinary references. */
const FRAME_ROLE = /mask|last|end|start|first/i;

export function slotCapacity(slot: ReferenceSlot): number {
    return Math.max(0, slot.max_count ?? (slot.multiple ? 256 : 1));
}

/** Image slots in fill order: ordinary references first, frames and masks last. */
export function referenceImageSlots(slots: readonly ReferenceSlot[]): ReferenceSlot[] {
    return slots
        .filter((slot) => slot.kind === "image")
        .sort((left, right) => Number(FRAME_ROLE.test(left.id)) - Number(FRAME_ROLE.test(right.id)));
}

export function countSourceAssets(sources: readonly ReferenceSource[]): number {
    return sources.reduce((total, source) => total + source.assetIds.length, 0);
}

/**
 * Resolve selected library assets into capability media slots.
 *
 * @param occupied current per-slot attachment count, so a second attach from
 *                 the picker cannot overfill an already used slot.
 */
export function resolveReferenceAssets(
    sources: readonly ReferenceSource[],
    slots: readonly ReferenceSlot[],
    occupied: Record<string, number> = {},
): ReferenceResolution {
    const imageSlots = referenceImageSlots(slots);
    const remaining = new Map<string, number>(imageSlots.map((slot) => [
        slot.id,
        Math.max(0, slotCapacity(slot) - Math.max(0, occupied[slot.id] ?? 0)),
    ]));
    const assignments: ReferenceAssignment[] = [];
    const refused: ReferenceRefusal[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
        for (const assetId of source.assetIds) {
            if (!ASSET_ID.test(assetId)) {
                refused.push({ assetId, entityId: source.entityId, entityName: source.entityName, reason: "invalid" });
                continue;
            }
            if (seen.has(assetId)) {
                refused.push({ assetId, entityId: source.entityId, entityName: source.entityName, reason: "duplicate" });
                continue;
            }
            const slot = imageSlots.find((candidate) => (remaining.get(candidate.id) ?? 0) > 0);
            if (!slot) {
                refused.push({
                    assetId,
                    entityId: source.entityId,
                    entityName: source.entityName,
                    reason: imageSlots.length === 0 ? "unsupported" : "capacity",
                });
                continue;
            }
            seen.add(assetId);
            remaining.set(slot.id, (remaining.get(slot.id) ?? 1) - 1);
            assignments.push({
                slotId: slot.id,
                slotLabel: slot.label,
                assetId,
                entityId: source.entityId,
                entityName: source.entityName,
            });
        }
    }

    return { assignments, refused };
}
