// Who works at the demonstration's company, and the categories and reports
// they read. Every report is built from the page templates an author would
// choose from, so what the demonstration shows is what the product builds.
//
// The people and the company are invented.

export const groups = {
	admins: "Platform Admins",
	everyone: "All Staff",
	sales: "Sales Operations",
	support: "Support Leads",
	marketing: "Marketing Team",
	finance: "Finance Team",
	operations: "Operations Team",
	people: "People Team",
	digital: "Digital Team",
};

// The first is who scripts/demo.mjs signs in as.
export const people: { email: string; groups: string[] }[] = [
	{
		email: "dalton.murray@example.com",
		groups: [groups.admins, groups.sales, groups.everyone],
	},
	{ email: "jamie.carter@example.com", groups: [groups.sales, groups.everyone] },
	{ email: "sam.lee@example.com", groups: [groups.support, groups.everyone] },
	{
		email: "jordan.reyes@example.com",
		groups: [groups.support, groups.everyone],
	},
	{ email: "casey.nguyen@example.com", groups: [groups.everyone] },
	{
		email: "morgan.ellis@example.com",
		groups: [groups.marketing, groups.everyone],
	},
	{
		email: "riley.chen@example.com",
		groups: [groups.finance, groups.everyone],
	},
	{
		email: "taylor.brooks@example.com",
		groups: [groups.operations, groups.everyone],
	},
	{ email: "avery.patel@example.com", groups: [groups.people, groups.everyone] },
	{
		email: "quinn.harper@example.com",
		groups: [groups.digital, groups.marketing, groups.everyone],
	},
];

export interface PageSeed {
	title: string;
	template: string;
	slots: Record<string, string>;
}

export interface ReportSeed {
	title: string;
	description: string;
	sourceKey: string;
	pages: PageSeed[];
}

export interface CategorySeed {
	id: string;
	name: string;
	icon: string;
	description: string;
	maintainers: { type: "user" | "group"; id: string }[];
	reports: ReportSeed[];
}

export const categories: CategorySeed[] = [
	{
		id: "sales",
		name: "Sales Performance",
		icon: "sales",
		description:
			"Revenue, margin and targets across regions, channels and products.",
		maintainers: [
			{ type: "user", id: "jamie.carter@example.com" },
			{ type: "group", id: groups.sales },
		],
		reports: [
			{
				title: "Revenue Overview",
				description: "Where revenue and margin stand, and how they got there.",
				sourceKey: "sales_orders",
				pages: [
					{
						title: "Overview",
						template: "overview",
						slots: {
							date: "Order Date",
							by: "Region",
							measure: "Revenue",
							second: "Gross Margin",
						},
					},
					{
						title: "Trend by channel",
						template: "trend",
						slots: { date: "Order Date", measure: "Revenue", split: "Channel" },
					},
					{
						title: "Region by channel",
						template: "comparison",
						slots: { rows: "Region", columns: "Channel", measure: "Revenue" },
					},
					{
						title: "Order activity",
						template: "activity",
						slots: { date: "Order Date", measure: "Orders", by: "Region" },
					},
				],
			},
			{
				title: "Product Performance",
				description:
					"Which products sell, which ones earn, and how big an order is.",
				sourceKey: "sales_orders",
				pages: [
					{
						title: "Product families",
						template: "breakdown",
						slots: { by: "Product Category", measure: "Revenue" },
					},
					{
						title: "Top products",
						template: "ranking",
						slots: { by: "Product", measure: "Gross Margin" },
					},
					{
						title: "Volume against margin",
						template: "relationship",
						slots: {
							by: "Product",
							across: "Units",
							up: "Margin Pct",
							size: "Revenue",
						},
					},
					{
						title: "Order sizes",
						template: "distribution",
						slots: {
							across: "Order ID",
							measure: "Revenue",
							group: "Product Category",
						},
					},
				],
			},
			{
				title: "Regional Targets",
				description: "Each region and each account manager against plan.",
				sourceKey: "sales_orders",
				pages: [
					{
						title: "By region",
						template: "target",
						slots: {
							by: "Region",
							actual: "Revenue",
							target: "Revenue Target",
						},
					},
					{
						title: "By account manager",
						template: "target",
						slots: {
							by: "Sales Rep",
							actual: "Revenue",
							target: "Revenue Target",
						},
					},
					{
						title: "Margin watch",
						template: "exception",
						slots: { by: "Country", measure: "Margin Pct", detail: "Revenue" },
					},
				],
			},
			{
				title: "Year on Year",
				description: "This year against last, and what moved most.",
				sourceKey: "sales_orders",
				pages: [
					{
						title: "By country",
						template: "comparison-period",
						slots: { date: "Order Date", by: "Country", measure: "Revenue" },
					},
					{
						title: "By product family",
						template: "comparison-period",
						slots: {
							date: "Order Date",
							by: "Product Category",
							measure: "Gross Margin",
						},
					},
				],
			},
			{
				title: "Customer Segments",
				description: "Who buys, and where they buy.",
				sourceKey: "sales_orders",
				pages: [
					{
						title: "Segments",
						template: "breakdown",
						slots: { by: "Customer Segment", measure: "Revenue" },
					},
					{
						title: "Segment to channel",
						template: "flow",
						slots: {
							from: "Customer Segment",
							to: "Channel",
							measure: "Revenue",
						},
					},
					{
						title: "Order value",
						template: "breakdown",
						slots: { by: "Channel", measure: "Average Order Value" },
					},
				],
			},
			{
				title: "Order Detail",
				description: "Orders by product, filtered by region, and any single order.",
				sourceKey: "sales_orders",
				pages: [
					{
						title: "Orders",
						template: "detail",
						slots: { primary: "Product", filter: "Region", measure: "Revenue" },
					},
					{
						title: "Look up an order",
						template: "profile",
						slots: {
							identifier: "Order ID",
							measure: "Revenue",
							detail: "Product",
						},
					},
				],
			},
		],
	},
	{
		id: "marketing",
		name: "Marketing",
		icon: "market",
		description: "What campaigns cost, what they brought in, and which channels earn it.",
		maintainers: [
			{ type: "user", id: "morgan.ellis@example.com" },
			{ type: "group", id: groups.marketing },
		],
		reports: [
			{
				title: "Campaign Performance",
				description: "Spend and return for every campaign.",
				sourceKey: "marketing_campaigns",
				pages: [
					{
						title: "Overview",
						template: "overview",
						slots: {
							date: "Day",
							by: "Channel",
							measure: "Attributed Revenue",
							second: "Spend",
						},
					},
					{
						title: "Campaign ranking",
						template: "ranking",
						slots: { by: "Campaign", measure: "Conversions" },
					},
					{
						title: "Spend against return",
						template: "relationship",
						slots: {
							by: "Campaign",
							across: "Spend",
							up: "Attributed Revenue",
							size: "Conversions",
						},
					},
				],
			},
			{
				title: "Channel Efficiency",
				description: "What each channel costs and returns.",
				sourceKey: "marketing_campaigns",
				pages: [
					{
						title: "Return on spend",
						template: "breakdown",
						slots: { by: "Channel", measure: "ROAS" },
					},
					{
						title: "Cost per conversion",
						template: "comparison",
						slots: {
							rows: "Channel",
							columns: "Region",
							measure: "Cost per Conversion",
						},
					},
					{
						title: "Click through",
						template: "exception",
						slots: {
							by: "Campaign",
							measure: "Click Through Pct",
							detail: "Impressions",
						},
					},
				],
			},
			{
				title: "Marketing Trends",
				description: "Clicks and conversions over time, and against last year.",
				sourceKey: "marketing_campaigns",
				pages: [
					{
						title: "Clicks by channel",
						template: "trend",
						slots: { date: "Day", measure: "Clicks", split: "Channel" },
					},
					{
						title: "Against last year",
						template: "comparison-period",
						slots: { date: "Day", by: "Channel", measure: "Conversions" },
					},
					{
						title: "Audiences",
						template: "breakdown",
						slots: { by: "Audience", measure: "Conversion Pct" },
					},
				],
			},
		],
	},
	{
		id: "finance",
		name: "Finance",
		icon: "rebates",
		description: "Operating spend against budget and forecast, by department and account.",
		maintainers: [
			{ type: "user", id: "riley.chen@example.com" },
			{ type: "group", id: groups.finance },
		],
		reports: [
			{
				title: "Budget vs Actual",
				description: "Where spend is running over or under plan.",
				sourceKey: "finance_ledger",
				pages: [
					{
						title: "By department",
						template: "target",
						slots: {
							by: "Department",
							actual: "Actual Spend",
							target: "Budget",
						},
					},
					{
						title: "Department by account",
						template: "comparison",
						slots: {
							rows: "Department",
							columns: "Account Group",
							measure: "Actual Spend",
						},
					},
					{
						title: "Over budget",
						template: "exception",
						slots: {
							by: "Department",
							measure: "Budget Variance Pct",
							detail: "Budget Variance",
						},
					},
				],
			},
			{
				title: "Spend Trend",
				description: "Spend month by month, and against last year.",
				sourceKey: "finance_ledger",
				pages: [
					{
						title: "By department",
						template: "trend",
						slots: {
							date: "Month",
							measure: "Actual Spend",
							split: "Department",
						},
					},
					{
						title: "Against last year",
						template: "comparison-period",
						slots: {
							date: "Month",
							by: "Account Group",
							measure: "Actual Spend",
						},
					},
				],
			},
			{
				title: "Forecast",
				description: "Where the year is heading against budget.",
				sourceKey: "finance_ledger",
				pages: [
					{
						title: "Forecast against budget",
						template: "target",
						slots: { by: "Department", actual: "Forecast", target: "Budget" },
					},
					{
						title: "By account",
						template: "breakdown",
						slots: { by: "Account Group", measure: "Forecast" },
					},
					{
						title: "By cost centre",
						template: "breakdown",
						slots: { by: "Cost Center", measure: "Budget Used Pct" },
					},
				],
			},
		],
	},
	{
		id: "operations",
		name: "Operations",
		icon: "field",
		description: "Shipping speed, reliability and cost across warehouses and carriers.",
		maintainers: [
			{ type: "user", id: "taylor.brooks@example.com" },
			{ type: "group", id: groups.operations },
		],
		reports: [
			{
				title: "Delivery Performance",
				description: "How reliably shipments arrive, by carrier and warehouse.",
				sourceKey: "operations_shipments",
				pages: [
					{
						title: "Overview",
						template: "overview",
						slots: {
							date: "Ship Date",
							by: "Carrier",
							measure: "Shipments",
							second: "On Time Pct",
						},
					},
					{
						title: "Late carriers",
						template: "exception",
						slots: {
							by: "Carrier",
							measure: "On Time Pct",
							detail: "Late Shipments",
						},
					},
					{
						title: "Days to deliver",
						template: "comparison",
						slots: {
							rows: "Warehouse",
							columns: "Service Level",
							measure: "Avg Delivery Days",
						},
					},
					{
						title: "Delivery times",
						template: "distribution",
						slots: {
							across: "Shipment ID",
							measure: "Avg Delivery Days",
							group: "Carrier",
						},
					},
				],
			},
			{
				title: "Freight Costs",
				description: "What shipping costs, and where the money goes.",
				sourceKey: "operations_shipments",
				pages: [
					{
						title: "By carrier",
						template: "breakdown",
						slots: { by: "Carrier", measure: "Freight Cost" },
					},
					{
						title: "Volume against cost",
						template: "relationship",
						slots: {
							by: "Warehouse",
							across: "Shipments",
							up: "Cost per Shipment",
							size: "Weight Kg",
						},
					},
					{
						title: "Cost trend",
						template: "trend",
						slots: {
							date: "Ship Date",
							measure: "Freight Cost",
							split: "Service Level",
						},
					},
				],
			},
			{
				title: "Warehouse Flow",
				description: "Where each warehouse ships to, and how busy it is.",
				sourceKey: "operations_shipments",
				pages: [
					{
						title: "Warehouse to region",
						template: "flow",
						slots: {
							from: "Warehouse",
							to: "Destination Region",
							measure: "Shipments",
						},
					},
					{
						title: "Daily volume",
						template: "activity",
						slots: { date: "Ship Date", measure: "Shipments", by: "Warehouse" },
					},
					{
						title: "Damage",
						template: "breakdown",
						slots: { by: "Carrier", measure: "Damage Pct" },
					},
				],
			},
		],
	},
	{
		id: "support",
		name: "Customer Support",
		icon: "customers",
		description: "How quickly customers hear back, and how they rate it.",
		maintainers: [
			{ type: "group", id: groups.support },
			{ type: "user", id: "sam.lee@example.com" },
		],
		reports: [
			{
				title: "Support Overview",
				description: "Ticket volume and satisfaction by team.",
				sourceKey: "support_tickets",
				pages: [
					{
						title: "Overview",
						template: "overview",
						slots: {
							date: "Opened Date",
							by: "Team",
							measure: "Tickets",
							second: "Satisfaction Score",
						},
					},
					{
						title: "Response trend",
						template: "trend",
						slots: {
							date: "Opened Date",
							measure: "Avg First Response Minutes",
							split: "Priority",
						},
					},
					{
						title: "Ticket calendar",
						template: "activity",
						slots: { date: "Opened Date", measure: "Tickets", by: "Team" },
					},
				],
			},
			{
				title: "Response Times",
				description: "How long customers wait, by priority and team.",
				sourceKey: "support_tickets",
				pages: [
					{
						title: "By priority",
						template: "breakdown",
						slots: { by: "Priority", measure: "Avg First Response Minutes" },
					},
					{
						title: "Team by channel",
						template: "comparison",
						slots: {
							rows: "Team",
							columns: "Channel",
							measure: "Avg Resolution Hours",
						},
					},
					{
						title: "Escalations",
						template: "exception",
						slots: { by: "Team", measure: "Escalation Pct", detail: "Tickets" },
					},
				],
			},
			{
				title: "Satisfaction",
				description: "What customers think, and what drives it.",
				sourceKey: "support_tickets",
				pages: [
					{
						title: "By channel",
						template: "breakdown",
						slots: { by: "Channel", measure: "Satisfaction Score" },
					},
					{
						title: "Wait against rating",
						template: "relationship",
						slots: {
							by: "Team",
							across: "Avg First Response Minutes",
							up: "Satisfaction Score",
							size: "Tickets",
						},
					},
				],
			},
		],
	},
	{
		id: "people",
		name: "People",
		icon: "contracts",
		description: "Headcount, hiring, attrition and engagement across the company.",
		maintainers: [
			{ type: "user", id: "avery.patel@example.com" },
			{ type: "group", id: groups.people },
		],
		reports: [
			{
				title: "Headcount",
				description: "How big each team is and how it has grown.",
				sourceKey: "people_headcount",
				pages: [
					{
						title: "Overview",
						template: "overview",
						slots: {
							date: "Month",
							by: "Department",
							measure: "Average Headcount",
							second: "Hires",
						},
					},
					{
						title: "Department by location",
						template: "comparison",
						slots: {
							rows: "Department",
							columns: "Location",
							measure: "Average Headcount",
						},
					},
					{
						title: "By level",
						template: "breakdown",
						slots: { by: "Level", measure: "Salary Cost" },
					},
				],
			},
			{
				title: "Attrition and Engagement",
				description: "Who is leaving, and how people feel.",
				sourceKey: "people_headcount",
				pages: [
					{
						title: "Attrition",
						template: "breakdown",
						slots: { by: "Department", measure: "Attrition Pct" },
					},
					{
						title: "Engagement watch",
						template: "exception",
						slots: {
							by: "Location",
							measure: "Engagement Score",
							detail: "Average Headcount",
						},
					},
					{
						title: "Engagement against attrition",
						template: "relationship",
						slots: {
							by: "Department",
							across: "Engagement Score",
							up: "Attrition Pct",
							size: "Average Headcount",
						},
					},
					{
						title: "Leavers over time",
						template: "trend",
						slots: { date: "Month", measure: "Exits", split: "Department" },
					},
				],
			},
			{
				title: "Hiring",
				description: "Roles filled against roles open.",
				sourceKey: "people_headcount",
				pages: [
					{
						title: "Hires against open roles",
						template: "target",
						slots: { by: "Department", actual: "Hires", target: "Open Roles" },
					},
					{
						title: "By location",
						template: "ranking",
						slots: { by: "Location", measure: "Hires" },
					},
				],
			},
		],
	},
	{
		id: "digital",
		name: "Digital",
		icon: "explore",
		description: "Visits to the online store, how they convert, and what they spend.",
		maintainers: [
			{ type: "user", id: "quinn.harper@example.com" },
			{ type: "group", id: groups.digital },
		],
		reports: [
			{
				title: "Site Traffic",
				description: "Where visitors come from and on what device.",
				sourceKey: "web_sessions",
				pages: [
					{
						title: "Overview",
						template: "overview",
						slots: {
							date: "Day",
							by: "Traffic Source",
							measure: "Sessions",
							second: "Web Orders",
						},
					},
					{
						title: "By device",
						template: "trend",
						slots: { date: "Day", measure: "Sessions", split: "Device" },
					},
					{
						title: "Visit calendar",
						template: "activity",
						slots: { date: "Day", measure: "Sessions", by: "Device" },
					},
				],
			},
			{
				title: "Conversion",
				description: "Which visits turn into orders.",
				sourceKey: "web_sessions",
				pages: [
					{
						title: "By source",
						template: "breakdown",
						slots: { by: "Traffic Source", measure: "Conversion Pct" },
					},
					{
						title: "Page by device",
						template: "comparison",
						slots: {
							rows: "Landing Page",
							columns: "Device",
							measure: "Conversion Pct",
						},
					},
					{
						title: "Source to page",
						template: "flow",
						slots: {
							from: "Traffic Source",
							to: "Landing Page",
							measure: "Sessions",
						},
					},
					{
						title: "Bounce watch",
						template: "exception",
						slots: {
							by: "Landing Page",
							measure: "Bounce Pct",
							detail: "Sessions",
						},
					},
				],
			},
			{
				title: "Web Revenue",
				description: "Online revenue against last year, and where it comes from.",
				sourceKey: "web_sessions",
				pages: [
					{
						title: "Against last year",
						template: "comparison-period",
						slots: { date: "Day", by: "Traffic Source", measure: "Web Revenue" },
					},
					{
						title: "By landing page",
						template: "ranking",
						slots: { by: "Landing Page", measure: "Web Revenue" },
					},
					{
						title: "By country",
						template: "breakdown",
						slots: { by: "Country", measure: "Revenue per Session" },
					},
				],
			},
		],
	},
];
