import { CharacterDetail } from "@/features/library/components/CharacterDetail";

export default async function CharacterDetailPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    return <CharacterDetail slug={slug} />;
}
