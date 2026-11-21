import { Suspense } from "react";
import { ScenesLibrary } from "@/features/scenes/components/ScenesLibrary";

export default function ScenesPage() {
    return <Suspense fallback={null}><ScenesLibrary /></Suspense>;
}
