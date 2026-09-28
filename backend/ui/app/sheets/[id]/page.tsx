import SheetEditor from "../SheetEditor";

export default async function SheetRoute({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <SheetEditor id={id} />;
}
