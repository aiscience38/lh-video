import "server-only";

import type { ModelCapabilities } from "@/models/capabilities/types";
import type { ProviderId } from "@/providers/types";

/**
 * Declared adapter support for every control the catalog can expose. This is a
 * review artifact, not a runtime switch: the matrix test in
 * scripts/verify-comfyui-capabilities.mjs fails when a capability declares a
 * control that its adapter does not translate, which keeps multi-shot and
 * native-audio flags honest and stops docs/providers/parity.md from drifting.
 *
 * "custom_fields" means the adapter forwards reviewed vendor fields (ComfyUI
 * maps template params; the other adapters validate and send contract fields).
 * "multi_shot" and "native_audio" are separate opt-ins so a new vendor field
 * cannot silently claim those capabilities through the generic path.
 */
export type CapabilityControl =
    | "prompt" | "negative_prompt" | "cfg_scale" | "style" | "shot_type" | "prompt_expansion" | "elements"
    | "duration" | "aspect_ratio" | "size" | "resolution_variant" | "seed"
    | "custom_fields" | "multi_shot" | "native_audio"
    | "image_slot" | "video_slot" | "audio_slot";

export interface AdapterSupport {
    controls: readonly CapabilityControl[];
    multiShot: boolean;
    nativeAudio: boolean;
}

const COMMON_TEXT: readonly CapabilityControl[] = ["prompt", "custom_fields"];

export const ADAPTER_SUPPORT: Record<ProviderId, AdapterSupport> = {
    // Native Gemini/Omni inputs; Veo-style negative prompts and seeds are not exposed.
    "google-ai-studio": { controls: [...COMMON_TEXT, "duration", "aspect_ratio", "resolution_variant", "image_slot", "video_slot", "audio_slot"], multiShot: false, nativeAudio: false },
    // Veo accepts negativePrompt, enhancePrompt, seed and generateAudio.
    "google-vertex": { controls: [...COMMON_TEXT, "negative_prompt", "prompt_expansion", "duration", "aspect_ratio", "resolution_variant", "seed", "image_slot", "video_slot"], multiShot: false, nativeAudio: true },
    // The gateway forwards reviewed vendor fields, including multiPrompt/multiShot and generateAudio.
    "vercel-ai-gateway": { controls: [...COMMON_TEXT, "negative_prompt", "duration", "aspect_ratio", "size", "resolution_variant", "seed", "image_slot", "video_slot", "audio_slot"], multiShot: true, nativeAudio: true },
    "toapis": { controls: [...COMMON_TEXT, "duration", "aspect_ratio", "size", "resolution_variant", "image_slot", "video_slot", "audio_slot"], multiShot: false, nativeAudio: true },
    "magnific": { controls: [...COMMON_TEXT, "duration", "aspect_ratio", "size", "resolution_variant", "image_slot", "video_slot", "audio_slot"], multiShot: true, nativeAudio: true },
    "runware": { controls: [...COMMON_TEXT, "duration", "aspect_ratio", "size", "resolution_variant", "seed", "image_slot", "video_slot", "audio_slot"], multiShot: true, nativeAudio: true },
    // The template graph owns everything except the canonical parameters it maps;
    // reference uploads are image-only in this adapter.
    "comfyui": { controls: ["prompt", "negative_prompt", "cfg_scale", "seed", "custom_fields", "image_slot"], multiShot: false, nativeAudio: false },
};

/** Vendor field ids that request generated audio rather than an audio reference. */
export const NATIVE_AUDIO_FIELDS: ReadonlySet<string> = new Set([
    "generate_audio", "generate_audio_switch", "generateAudio", "metadata.generateAudio",
    "sound_effects", "no_music", "audio", "audio_setting", "metadata.audio",
    "metadata.keep_original_sound", "keepOriginalSound", "settings.audio",
    "providerSettings.alibaba.audio", "providerSettings.google.generateAudio",
    "providerSettings.vidu.audio", "providerSettings.pixverse.audio",
    "providerSettings.klingai.sound", "providerSettings.klingai.keepOriginalSound", "metadata.parameters.audio",
]);

/** Vendor field ids that expose more than one shot per generation. */
export const MULTI_SHOT_FIELDS: ReadonlySet<string> = new Set([
    "shotType", "multiShot", "multiPrompt", "multi_prompt", "multi_shot", "multishot",
    "multiClip", "generate_multi_clip_switch", "settings.multiClip", "providerSettings.klingai.multiPrompt", "providerSettings.pixverse.multiClip",
]);

/** A new vendor field must be classified here before the matrix accepts it. */
export const UNCLASSIFIED_AUDIO = /(?:^|[._])(?:generate_?audio|sound_?effects|keep_?original_?sound)(?:$|[._])/i;
export const UNCLASSIFIED_MULTI_SHOT = /(?:multi_?shot|multi_?prompt|multi_?clip)/i;

export interface DeclaredControl {
    id: CapabilityControl;
    source: string;
}

/** Every control a capability declares, with the field that declared it. */
export function declaredControls(capability: ModelCapabilities): DeclaredControl[] {
    const controls: DeclaredControl[] = [];
    const add = (id: CapabilityControl, source: string) => { if (!controls.some(entry => entry.id === id)) controls.push({ id, source }); };
    if (capability.prompt_supported !== false) add("prompt", "prompt");
    for (const flag of ["negative_prompt", "cfg_scale", "style", "shot_type", "prompt_expansion", "elements"] as const) {
        if (capability[flag] === true) add(flag, flag);
    }
    if (capability.duration !== false) add("duration", "duration");
    if (capability.aspect_ratio !== false) add("aspect_ratio", "aspect_ratio");
    if (capability.size !== false) add("size", "size");
    if (capability.resolution_variant !== false) add("resolution_variant", "resolution_variant");
    if (capability.seed !== undefined && capability.seed !== false) add("seed", "seed");
    if (capability.custom_fields.length > 0) add("custom_fields", "custom_fields");
    if (capability.shot_type === true) add("multi_shot", "shot_type");
    for (const field of capability.custom_fields) {
        if (NATIVE_AUDIO_FIELDS.has(field.id)) add("native_audio", field.id);
        if (MULTI_SHOT_FIELDS.has(field.id)) add("multi_shot", field.id);
    }
    for (const slot of capability.media_slots) {
        if (slot.kind === "image") add("image_slot", slot.id);
        if (slot.kind === "video") add("video_slot", slot.id);
        if (slot.kind === "audio") add("audio_slot", slot.id);
    }
    return controls;
}
