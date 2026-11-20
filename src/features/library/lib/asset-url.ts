const UPLOADED_ASSET = /^asset_([a-f0-9]{64})$/;
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolve a library asset id to the media route that serves it.
 * Uploaded references use `asset_<sha256>`; generated task ids use the download route.
 */
export function libraryAssetUrl(assetId: string, index = 0): string | null {
    const uploaded = UPLOADED_ASSET.exec(assetId);
    if (uploaded) return `/api/uploaded/${uploaded[1]}.jpg`;
    if (!ASSET_ID.test(assetId)) return null;
    return `/api/download/${encodeURIComponent(assetId)}?index=${Math.max(0, Math.trunc(index))}&inline=1`;
}
