import "server-only";

import { z } from "zod";

/**
 * Creative Library contract.
 *
 * Every entity is one JSON document at
 * `STORAGE_ROOT/library/<kind folder>/<slug>/<kind>.json`. Media is never
 * copied into the library: entities reference existing asset ids only.
 */

export const LIBRARY_KINDS = ["character", "scene", "storyboard"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export const LIBRARY_KIND_ERROR = "ERR_LIBRARY_KIND";
export const LIBRARY_NOT_FOUND_ERROR = "ERR_LIBRARY_NOT_FOUND";
export const LIBRARY_INVALID_ERROR = "ERR_LIBRARY_INVALID";
export const LIBRARY_CONFLICT_ERROR = "ERR_LIBRARY_CONFLICT";

/** Folder segment per kind, relative to `STORAGE_ROOT/library`. */
export const LIBRARY_KIND_FOLDERS: Record<LibraryKind, string> = {
    character: "characters",
    scene: "scenes",
    storyboard: "storyboards",
};

/** Document file name per kind. */
export const LIBRARY_KIND_FILES: Record<LibraryKind, string> = {
    character: "character.json",
    scene: "scene.json",
    storyboard: "storyboard.json",
};

/** Matches media/task asset identifiers and is always safe as a path segment. */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Two characters minimum because the first character is followed by one to 48. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
export const MAX_SLUG_LENGTH = 49;

/** Windows device names cannot be directory names, even lowercase and without extension. */
const RESERVED_SLUGS = new Set([
    "con", "prn", "aux", "nul", "clock$",
    ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export const assetIdSchema = z.string().regex(ASSET_ID_PATTERN, { error: LIBRARY_INVALID_ERROR });

/** Google-Flow-style ingredient role inside the character collection. */
export const INGREDIENT_KINDS = ["character", "prop", "style"] as const;
export const ingredientKindSchema = z.enum(INGREDIENT_KINDS, { error: LIBRARY_INVALID_ERROR }).default("character");

export function isValidSlug(value: unknown): value is string {
    return typeof value === "string" && SLUG_PATTERN.test(value) && !RESERVED_SLUGS.has(value);
}

export const slugSchema = z.string().refine(isValidSlug, { error: LIBRARY_INVALID_ERROR });

/**
 * Derives a lowercase, separator-safe slug from a display name.
 * The result may be shorter than the slug minimum (for example a one-letter
 * name) or empty for names without ASCII letters or digits; callers must
 * validate it with `isValidSlug` before creating an entity.
 */
export function slugify(name: string): string {
    return name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_SLUG_LENGTH)
        .replace(/-+$/g, "");
}

export function isLibraryKind(value: unknown): value is LibraryKind {
    return typeof value === "string" && (LIBRARY_KINDS as readonly string[]).includes(value);
}

const entityIdSchema = z.uuid();
const entityNameSchema = z.string().min(1).max(120);
const timestampSchema = z.iso.datetime({ offset: true });
const productionIdSchema = z.string().min(1).max(128);

/** A scene shot: generation intent plus references to existing assets and tasks. */
export const shotSchema = z.object({
    id: entityIdSchema,
    order: z.number().int().min(0),
    prompt: z.string().default(""),
    capabilityId: z.string().min(1).max(200).nullable().default(null),
    params: z.record(z.string(), z.unknown()).default(() => ({})),
    assetIds: z.array(assetIdSchema).default(() => []),
    taskIds: z.array(assetIdSchema).default(() => []),
});
export type Shot = z.infer<typeof shotSchema>;

export const characterSchema = z.object({
    id: entityIdSchema,
    kind: z.literal("character"),
    ingredientKind: ingredientKindSchema,
    name: entityNameSchema,
    slug: slugSchema,
    notes: z.string().max(4000).default(""),
    assetIds: z.array(assetIdSchema).default(() => []),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});
export type Character = z.infer<typeof characterSchema>;

export const sceneSchema = z.object({
    id: entityIdSchema,
    kind: z.literal("scene"),
    name: entityNameSchema,
    slug: slugSchema,
    shots: z.array(shotSchema).default(() => []),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});
export type Scene = z.infer<typeof sceneSchema>;

/** An ordered storyboard panel. Seconds are estimated generation duration, not a promise. */
export const storyboardShotSchema = z.object({
    id: entityIdSchema,
    order: z.number().int().min(0),
    intent: z.string().default(""),
    seconds: z.number().positive().default(3),
    keyframeAssetId: assetIdSchema.nullable().default(null),
    camera: z.string().default(""),
});
export type StoryboardShot = z.infer<typeof storyboardShotSchema>;

export const storyboardSchema = z.object({
    id: entityIdSchema,
    kind: z.literal("storyboard"),
    name: entityNameSchema,
    slug: slugSchema,
    productionId: productionIdSchema.nullable().default(null),
    shots: z.array(storyboardShotSchema).default(() => []),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});
export type Storyboard = z.infer<typeof storyboardSchema>;

export const libraryEntitySchema = z.discriminatedUnion("kind", [characterSchema, sceneSchema, storyboardSchema]);
export type LibraryEntity = z.infer<typeof libraryEntitySchema>;

export function schemaForKind(kind: LibraryKind): z.ZodType<LibraryEntity> {
    switch (kind) {
        case "character": return characterSchema as z.ZodType<LibraryEntity>;
        case "scene": return sceneSchema as z.ZodType<LibraryEntity>;
        case "storyboard": return storyboardSchema as z.ZodType<LibraryEntity>;
        default: throw new Error(LIBRARY_KIND_ERROR);
    }
}

export const characterCreateSchema = characterSchema.pick({ name: true, notes: true, assetIds: true, ingredientKind: true });
export const sceneCreateSchema = sceneSchema.pick({ name: true, shots: true });
export const storyboardCreateSchema = storyboardSchema.pick({ name: true, productionId: true, shots: true });
export type CharacterCreateInput = z.infer<typeof characterCreateSchema>;
export type SceneCreateInput = z.infer<typeof sceneCreateSchema>;
export type StoryboardCreateInput = z.infer<typeof storyboardCreateSchema>;
export type LibraryCreateInput = CharacterCreateInput | SceneCreateInput | StoryboardCreateInput;

/** Update schemas drop server-owned fields and intentionally have no defaults. */
export const characterUpdateSchema = z.object({
    name: entityNameSchema.optional(),
    notes: z.string().max(4000).optional(),
    assetIds: z.array(assetIdSchema).optional(),
    ingredientKind: ingredientKindSchema.optional(),
});
export const sceneUpdateSchema = z.object({
    name: entityNameSchema.optional(),
    shots: z.array(shotSchema).optional(),
});
export const storyboardUpdateSchema = z.object({
    name: entityNameSchema.optional(),
    productionId: productionIdSchema.nullable().optional(),
    shots: z.array(storyboardShotSchema).optional(),
});
export type CharacterUpdateInput = z.infer<typeof characterUpdateSchema>;
export type SceneUpdateInput = z.infer<typeof sceneUpdateSchema>;
export type StoryboardUpdateInput = z.infer<typeof storyboardUpdateSchema>;
export type LibraryUpdateInput = CharacterUpdateInput | SceneUpdateInput | StoryboardUpdateInput;

export function createSchemaFor(kind: LibraryKind): z.ZodType<LibraryCreateInput> {
    switch (kind) {
        case "character": return characterCreateSchema as z.ZodType<LibraryCreateInput>;
        case "scene": return sceneCreateSchema as z.ZodType<LibraryCreateInput>;
        case "storyboard": return storyboardCreateSchema as z.ZodType<LibraryCreateInput>;
        default: throw new Error(LIBRARY_KIND_ERROR);
    }
}

export function updateSchemaFor(kind: LibraryKind): z.ZodType<LibraryUpdateInput> {
    switch (kind) {
        case "character": return characterUpdateSchema as z.ZodType<LibraryUpdateInput>;
        case "scene": return sceneUpdateSchema as z.ZodType<LibraryUpdateInput>;
        case "storyboard": return storyboardUpdateSchema as z.ZodType<LibraryUpdateInput>;
        default: throw new Error(LIBRARY_KIND_ERROR);
    }
}
