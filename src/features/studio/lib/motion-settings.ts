/**
 * Client-side motion preset application. Canonical parameters own the names;
 * a preset only lands a value when the selected capability actually exposes
 * that control and accepts the value, so a recommendation can never make a
 * valid submission invalid.
 */
import type { ModelCapabilities } from "@/models/capabilities/types";
import type { MotionPreset } from "@/models/motion-params";
import { getAspectRatios, getDurations, getSizes } from "@/models/capabilities/video-helpers";
import type { SettingsValues } from "@/features/studio/model-settings";

export function settingsWithMotionPreset(
    preset: MotionPreset,
    settings: SettingsValues,
    capability: ModelCapabilities,
    variantId?: string,
): SettingsValues {
    const next: SettingsValues = { ...settings };
    for (const [key, value] of Object.entries(preset.paramOverrides)) {
        if (value === undefined) continue;
        switch (key) {
            case "duration": {
                const duration = String(value);
                if (getDurations(capability, variantId).includes(duration)) next.duration = duration;
                break;
            }
            case "aspect_ratio": {
                const ratios = getAspectRatios(capability, variantId) ?? [];
                const ratio = String(value);
                if (ratios.some(([, option]) => option === ratio)) next.aspectRatio = ratio;
                break;
            }
            case "size": {
                const sizes = getSizes(capability, variantId) ?? [];
                const size = String(value);
                if (sizes.some(([, option]) => option === size)) next.size = size;
                break;
            }
            case "cfg_scale":
                if (capability.cfg_scale && typeof value === "number") next.cfgScale = value;
                break;
            case "seed":
                if (capability.seed) next.seed = String(value);
                break;
            case "style":
                if (capability.style && typeof value === "string") next.style = value;
                break;
            case "shot_type":
                if (capability.shot_type && typeof value === "string") next.shotType = value;
                break;
            case "expand_prompt":
                if (capability.prompt_expansion) next.expandPrompt = Boolean(value);
                break;
            default:
                break;
        }
    }
    return next;
}
