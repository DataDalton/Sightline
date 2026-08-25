import CategoryView from "../CategoryView";

export default async function CategoryPage({
	params,
}: {
	params: Promise<{ categoryId: string }>;
}) {
	const { categoryId } = await params;
	return <CategoryView categoryId={categoryId} />;
}
