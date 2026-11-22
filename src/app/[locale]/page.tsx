import { StudioShell } from "@/features/studio/components/StudioShell";

export default function StudioPage() {
    // No Suspense boundary: a plain client component needs none, and the streaming
    // boundary could insert a late chunk after hydration, duplicating the composer.
    return <StudioShell />;
}
