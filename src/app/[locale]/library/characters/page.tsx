import { Suspense } from "react";
import { CharactersLibrary } from "@/features/library/components/CharactersLibrary";

export default function CharactersPage() {
    return <Suspense fallback={null}><CharactersLibrary /></Suspense>;
}
