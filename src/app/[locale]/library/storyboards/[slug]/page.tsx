import { Suspense } from "react";
import { StoryboardEditor } from "@/features/library/components/storyboards/StoryboardEditor";

export default async function StoryboardDetailPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    return <Suspense fallback={null}><StoryboardEditor slug={slug} /></Suspense>;
}
