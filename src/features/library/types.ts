export type LibraryKind = "character" | "scene" | "storyboard";

/** Google-Flow-style ingredient role stored on a character entity. */
export const INGREDIENT_KINDS = ["character", "prop", "style"] as const;
export type IngredientKind = (typeof INGREDIENT_KINDS)[number];

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
