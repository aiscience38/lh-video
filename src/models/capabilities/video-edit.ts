import type { ModelCapabilities } from "./types";

/**
 * Video-to-video editing is a separate capability from video references,
 * motion inputs and last-frame extension. Only a capability that explicitly
 * declares `video_edit` may enable the detail page's provider-backed composer;
 * the catalog's video slots are not enough because no adapter translates an
 * edited source video end to end.
 */
export function declaresVideoEditing(capability: ModelCapabilities): boolean {
    const declaration = capability.video_edit;
    return Boolean(declaration && declaration.source_slot.trim() && declaration.modes.some(mode => mode.trim()));
}

/** The video capabilities the edit composer may list, in catalog order. */
export function videoEditingCapabilities(capabilities: readonly ModelCapabilities[]): ModelCapabilities[] {
    return capabilities.filter(declaresVideoEditing);
}
