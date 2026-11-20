import { Suspense } from "react";
import { LibraryCollection } from "@/features/library/components/LibraryCollection";

export default function StoryboardsPage() {
    return <Suspense fallback={null}><LibraryCollection kind="storyboard" /></Suspense>;
}
