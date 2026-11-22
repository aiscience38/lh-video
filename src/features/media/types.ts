export interface FilmstripFrame {
    index: number;
    timeSeconds: number;
    url: string;
}

export interface Filmstrip {
    taskId: string;
    durationSeconds: number;
    frameCount: number;
    fps: number;
    width: number | null;
    height: number | null;
    cached: boolean;
    frames: FilmstripFrame[];
}

export interface MediaNote {
    id: string;
    subjectId: string;
    taskId: string | null;
    assetId: string | null;
    tSeconds: number;
    text: string;
    createdAt: string;
    decision: boolean;
}

export interface LastFrameAsset {
    assetId: string;
    url: string;
    sourceTaskId: string;
}
