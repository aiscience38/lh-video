import { Suspense } from "react";
import { SceneBoard } from "@/features/scenes/components/SceneBoard";

export default async function SceneBoardPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <Suspense fallback={null}><SceneBoard sceneId={id} /></Suspense>;
}
