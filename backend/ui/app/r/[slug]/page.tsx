import ReportView from "../ReportView";

export default async function ReportPage({
	params,
}: {
	params: Promise<{ slug: string }>;
}) {
	const { slug } = await params;
	return <ReportView slug={slug} />;
}
