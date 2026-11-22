export type LibraryKind = "character" | "scene" | "storyboard";

/** Google-Flow-style ingredient role stored on a character entity. */
export const INGREDIENT_KINDS = ["character", "prop", "style"] as const;
export type IngredientKind = (typeof INGREDIENT_KINDS)[number];

/** Text-to-speech providers that can supply a character voice. */
export const VOICE_PROVIDERS = ["elevenlabs", "comfyui", "none"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

/** Mirrors `voiceProfileSchema` in the server contract. */
export interface CharacterVoice {
    provider: VoiceProvider;
    voiceId: string | null;
    language: string;
    settings: Record<string, unknown>;
    previewAssetId: string | null;
}

export const DEFAULT_CHARACTER_VOICE: CharacterVoice = {
    provider: "none",
    voiceId: null,
    language: "en",
    settings: {},
    previewAssetId: null,
};

/** Languages offered by the voice picker; stored as BCP-47 tags. */
export const VOICE_LANGUAGES = ["en", "es", "pt-BR", "fr", "de", "it", "ja", "ko", "zh"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export interface LibraryEntityBase {
    id: string;
    kind: LibraryKind;
    name: string;
    slug: string;
    createdAt: string;
    updatedAt: string;
}

export interface CharacterEntity extends LibraryEntityBase {
    kind: "character";
    ingredientKind: IngredientKind;
    notes: string;
    assetIds: string[];
    voice: CharacterVoice;
}

export interface SceneEntity extends LibraryEntityBase {
    kind: "scene";
    shots: unknown[];
}

export interface StoryboardEntity extends LibraryEntityBase {
    kind: "storyboard";
    productionId: string | null;
    shots: unknown[];
}

export type LibraryEntity = CharacterEntity | SceneEntity | StoryboardEntity;

export interface LibraryListResponse {
    entities: LibraryEntity[];
    count: number;
}

export interface LibraryAssetUpload {
    assetId: string;
    url: string;
}

export function isCharacter(entity: LibraryEntity): entity is CharacterEntity {
    return entity.kind === "character";
}
