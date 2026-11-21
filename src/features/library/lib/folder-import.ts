/**
 * Pure planning for folder reference imports.
 *
 * The browser exposes a folder selection as a flat FileList where every file
 * carries `webkitRelativePath` (for example `photos/Ana/1.png`). This module
 * turns that flat list into character buckets without touching the network so
 * the dialog only has to upload and save.
 */

const IMAGE_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "tif", "tiff", "svg",
]);

const FALLBACK_NAME = "Imported";

export interface FolderImportCharacter {
    /** Display name taken from the first-level folder (or the selected folder). */
    name: string;
    /** Image files in natural filename order. */
    files: File[];
}

export interface FolderImportPlan {
    characters: FolderImportCharacter[];
    /** Relative paths of non-image files, one report line each. */
    skipped: string[];
}

function relativePath(file: File): string {
    const relative = typeof file.webkitRelativePath === "string" ? file.webkitRelativePath : "";
    return (relative || file.name).replaceAll("\\", "/").replace(/^\/+/, "");
}

function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImageFile(file: File): boolean {
    if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
    return IMAGE_EXTENSIONS.has(extensionOf(file.name));
}

/** Natural order so `2.png` sorts before `10.png`. */
function compareNames(a: string, b: string): number {
    return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/**
 * Builds the import plan.
 *
 * A directory selection normally includes the selected folder as the first
 * path segment. When every file shares one first segment we treat it as that
 * root; otherwise (some automation and synthetic FileLists omit the root) the
 * first segment is already the first-level folder.
 */
export function planFolderImport(input: File[]): FolderImportPlan {
    const entries = input
        .map(file => ({ file, path: relativePath(file), segments: relativePath(file).split("/").filter(Boolean) }))
        .filter(entry => entry.segments.length > 0);
    const firstSegments = new Set(entries.filter(entry => entry.segments.length > 1).map(entry => entry.segments[0]));
    const root = firstSegments.size === 1 ? [...firstSegments][0] : "";
    const buckets = new Map<string, File[]>();
    const skipped: string[] = [];

    for (const entry of entries) {
        const rest = root && entry.segments[0] === root ? entry.segments.slice(1) : entry.segments;
        const name = rest.length >= 2 ? rest[0] : root || FALLBACK_NAME;
        if (!isImageFile(entry.file)) {
            skipped.push(entry.path);
            continue;
        }
        const bucket = buckets.get(name);
        if (bucket) bucket.push(entry.file);
        else buckets.set(name, [entry.file]);
    }

    const characters = [...buckets.entries()]
        .map(([name, files]) => ({
            name,
            files: [...files].sort((a, b) => compareNames(a.name, b.name) || compareNames(relativePath(a), relativePath(b))),
        }))
        .sort((a, b) => compareNames(a.name, b.name));

    return { characters, skipped: skipped.sort(compareNames) };
}

/** Client mirror of the store slug rule, used only to match existing entities. */
export function importSlug(name: string): string {
    return name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 49)
        .replace(/-+$/g, "");
}
