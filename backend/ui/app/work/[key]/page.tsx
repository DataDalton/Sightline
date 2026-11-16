import WorkItemView from "../WorkItemView";

export default async function WorkItemRoute({
	params,
}: {
	params: Promise<{ key: string }>;
}) {
	const { key } = await params;
	return <WorkItemView itemKey={decodeURIComponent(key)} />;
}
