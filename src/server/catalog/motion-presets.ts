import "server-only";

/**
 * Camera motion presets — the catalog entry point, mirroring
 * `src/server/catalog/image.ts`: a keyed record, a sorted list for the API and
 * lookup helpers. Presets are canonical data: the composer merges
 * `paramOverrides` into its submitted settings and appends `promptFragment`
 * to the prompt, so both are visible in the prompt preview.
 */
import type { MotionPreset } from "@/models/motion-params";

/**
 * Capability families whose models accept camera direction in the prompt.
 * Tokens are matched without case or separators (see `motionPresetAppliesToFamily`),
 * which covers built-in families such as "Veo 3.1" and per-model families such
 * as "Seedance-2-5-Pro-480p" without enumerating every discovered model.
 */
export const MOTION_FAMILY_TOKENS: readonly string[] = [
    "seedance",
    "veo",
    "kling",
    "wan",
    "alibaba",
    "bytedance",
    "google",
    "bfl",
    "minimax",
    "hailuo",
    "pixverse",
    "runway",
    "vidu",
    "sora",
    "grok",
    "ltx",
    "ray3",
    "midjourney",
    "pvideo",
    "skyreels",
    "happyhorse",
    "geminiomni",
];

export const MOTION_PRESETS: Record<string, MotionPreset> = {
    "crash-zoom": {
        id: "crash-zoom",
        label: "Crash zoom",
        appliesTo: [...MOTION_FAMILY_TOKENS],
        promptFragment: "The camera crash-zooms toward the subject in one fast push, landing in a tight shot.",
        paramOverrides: { duration: "4" },
    },
    "dolly-in": {
        id: "dolly-in",
        label: "Dolly in",
        appliesTo: [...MOTION_FAMILY_TOKENS],
        promptFragment: "The camera dollies in slowly and steadily, keeping the subject centered.",
        paramOverrides: { duration: "6" },
    },
    orbit: {
        id: "orbit",
        label: "Orbit",
        appliesTo: [...MOTION_FAMILY_TOKENS],
        promptFragment: "The camera orbits the subject in a smooth half circle, revealing the background.",
        paramOverrides: { duration: "6" },
    },
    "whip-pan": {
        id: "whip-pan",
        label: "Whip pan",
        appliesTo: [...MOTION_FAMILY_TOKENS],
        promptFragment: "The camera whip-pans across the scene and snaps onto the next subject.",
        paramOverrides: { duration: "4" },
    },
    "bullet-time": {
        id: "bullet-time",
        label: "Bullet time",
        appliesTo: [...MOTION_FAMILY_TOKENS],
        promptFragment: "Time freezes mid-action while the camera arcs around the subject in bullet time.",
        paramOverrides: { duration: "5" },
    },
    handheld: {
        id: "handheld",
        label: "Handheld",
        appliesTo: [...MOTION_FAMILY_TOKENS],
        promptFragment: "The camera is handheld, with subtle natural shake and breathing movement.",
        paramOverrides: { duration: "8" },
    },
};

export const MOTION_PRESETS_LIST: MotionPreset[] = Object.values(MOTION_PRESETS)
    .sort((a, b) => a.label.localeCompare(b.label, "en"));

export function getMotionPreset(id: string): MotionPreset | undefined {
    return MOTION_PRESETS[id];
}

export function getMotionPresetsForFamily(family: string): MotionPreset[] {
    const compact = family.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return MOTION_PRESETS_LIST.filter((preset) => preset.appliesTo.some((token) => {
        const needle = token.toLowerCase().replace(/[^a-z0-9]+/g, "");
        return needle.length > 0 && compact.includes(needle);
    }));
}
