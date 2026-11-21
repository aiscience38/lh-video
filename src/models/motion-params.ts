/**
 * Motion presets — shared contract between the server catalog, the catalog API
 * and the composer. Pure data shapes and pure helpers only: no server-only
 * boundary so the client can merge overrides before submitting a generation.
 */
import type { CanonicalParams } from "./canonical";

export interface MotionPreset {
    id: string;
    label: string;
    /**
     * Capability family tokens this preset is offered for. Matching is
     * case-insensitive and ignores separators, because catalog families mix
     * forms such as "Veo 3.1", "Kling-V3-Pro" and "Seedance-2-5-Pro-480p".
     */
    appliesTo: string[];
    /** Appended to the user prompt with exactly one space. */
    promptFragment: string;
    /** Canonical parameters the preset recommends. */
    paramOverrides: Partial<CanonicalParams>;
}

/** Family names compact to letters and digits so separators never matter. */
export function compactFamily(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function motionPresetAppliesToFamily(preset: MotionPreset, family: string): boolean {
    const compact = compactFamily(family);
    if (!compact) return false;
    return preset.appliesTo.some((token) => {
        const needle = compactFamily(token);
        return needle.length > 0 && compact.includes(needle);
    });
}

export function motionPresetsForFamily(presets: readonly MotionPreset[], family: string): MotionPreset[] {
    return presets.filter((preset) => motionPresetAppliesToFamily(preset, family));
}

/** True when at least one catalog preset targets this capability family. */
export function familySupportsMotion(presets: readonly MotionPreset[], family: string): boolean {
    return motionPresetsForFamily(presets, family).length > 0;
}

/** Merge the preset's recommended canonical parameters over the submitted ones. */
export function applyMotionPreset(preset: MotionPreset | null | undefined, canonical: CanonicalParams): CanonicalParams {
    if (!preset) return { ...canonical };
    return { ...canonical, ...preset.paramOverrides };
}

/** Append the camera fragment so the prompt preview and the request agree. */
export function composeMotionPrompt(preset: MotionPreset | null | undefined, prompt: string): string {
    if (!preset) return prompt;
    const trimmed = prompt.trim();
    return trimmed ? `${trimmed} ${preset.promptFragment}` : preset.promptFragment;
}
