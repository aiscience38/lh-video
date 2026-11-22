import { MediaDetail } from "@/features/media/components/MediaDetail";

export default async function MediaDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
    const { taskId } = await params;
    return <MediaDetail taskId={taskId} />;
}
