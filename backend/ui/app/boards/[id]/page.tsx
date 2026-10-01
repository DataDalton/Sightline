import BoardView from "../BoardView";

export default async function BoardRoute({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <BoardView id={id} />;
}
