import { Suspense } from "react";
import { LibraryCollection } from "@/features/library/components/LibraryCollection";

export default function ScenesPage() {
    return <Suspense fallback={null}><LibraryCollection kind="scene" /></Suspense>;
}
