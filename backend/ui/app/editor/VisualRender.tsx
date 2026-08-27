"use client";

// What a visual actually looks like, at the size it is read at.
//
// The picker's card carries a 64 by 40 schematic, which is the right thing for
// a grid of thirty-five of them: it says what shape a thing is at a glance. It
// is the wrong thing for deciding, because at that size a chart is four bars
// and no axis, and every table is three grey lines.
//
// So this is the same visual drawn properly: axes with ticks, labels a reader
// would actually see, a legend where there would be one, and plausible figures
// rather than placeholder blocks. The controls are drawn as the controls they
// are, with their own borders and chevrons and handles, because a filter is a
// piece of interface and drawing it as an abstract box is what made half of
// them indistinguishable in the first place.
//
// Drawn rather than rendered from real data on purpose. A preview has to be
// instant and identical every time, and it has to work for a type the current
// page has no source for.

const w = 260;
const h = 150;
// The plot: room on the left for value labels and below for category labels.
const l = 32;
const r = 250;
const t = 14;
const b = 118;

const c1 = "var(--chart-1)";
const c2 = "var(--chart-2)";
const c3 = "var(--chart-3)";
const c4 = "var(--chart-4)";
const line = "var(--border-subtle)";
const edge = "var(--border-strong)";
const ink = "var(--text-muted)";
const paper = "var(--surface-raised)";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
const regions = ["North", "South", "East", "West", "Central"];

function Label({
	x,
	y,
	children,
	anchor = "middle",
	size = 7,
	weight = 400,
	fill = ink,
}: {
	x: number;
	y: number;
	children: React.ReactNode;
	anchor?: "start" | "middle" | "end";
	size?: number;
	weight?: number;
	fill?: string;
}) {
	return (
		<text
			x={x}
			y={y}
			textAnchor={anchor}
			fontSize={size}
			fontWeight={weight}
			fill={fill}
			fontFamily="inherit"
		>
			{children}
		</text>
	);
}

// Horizontal rules with the values they sit at, which is most of what makes a
// chart readable and all of what the small drawing had to leave out.
function Grid({ ticks = ["0", "25", "50", "75"] }: { ticks?: string[] }) {
	const step = (b - t) / (ticks.length - 1);
	return (
		<>
			{ticks.map((tick, i) => {
				const y = b - i * step;
				return (
					<g key={tick}>
						<line
							x1={l}
							y1={y}
							x2={r}
							y2={y}
							stroke={line}
							strokeWidth="1"
						/>
						<Label x={l - 4} y={y + 2.5} anchor="end">
							{tick}
						</Label>
					</g>
				);
			})}
		</>
	);
}

function XLabels({ items }: { items: string[] }) {
	const slot = (r - l) / items.length;
	return (
		<>
			{items.map((item, i) => (
				<Label key={item} x={l + slot * (i + 0.5)} y={b + 11}>
					{item}
				</Label>
			))}
		</>
	);
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
	let x = l;
	return (
		<>
			{items.map((item) => {
				const at = x;
				x += item.label.length * 4.1 + 16;
				return (
					<g key={item.label}>
						<rect
							x={at}
							y={h - 9}
							width="7"
							height="7"
							rx="1.5"
							fill={item.color}
						/>
						<Label x={at + 10} y={h - 3.5} anchor="start">
							{item.label}
						</Label>
					</g>
				);
			})}
		</>
	);
}

// --- controls --------------------------------------------------------------
//
// A filter is a piece of interface, so it is drawn as one. These are the
// pieces every control is built from.

function Field({
	x,
	y,
	width,
	height = 18,
	children,
}: {
	x: number;
	y: number;
	width: number;
	height?: number;
	children?: React.ReactNode;
}) {
	return (
		<>
			<rect
				x={x}
				y={y}
				width={width}
				height={height}
				rx="3"
				fill={paper}
				stroke={edge}
				strokeWidth="1"
			/>
			{children}
		</>
	);
}

function Chevron({ x, y }: { x: number; y: number }) {
	return (
		<path
			d={`M${x} ${y} l3 3.4 l3 -3.4`}
			fill="none"
			stroke={c1}
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	);
}

function Segmented({
	x,
	y,
	width,
	items,
	active,
}: {
	x: number;
	y: number;
	width: number;
	items: string[];
	active: number;
}) {
	const cell = (width - 4) / items.length;
	return (
		<>
			<rect
				x={x}
				y={y}
				width={width}
				height="20"
				rx="4"
				fill="var(--surface-sunken)"
				stroke={line}
			/>
			{items.map((item, i) => (
				<g key={item}>
					{i === active && (
						<rect
							x={x + 2 + cell * i}
							y={y + 2}
							width={cell}
							height="16"
							rx="3"
							fill={paper}
							stroke={edge}
						/>
					)}
					<Label
						x={x + 2 + cell * (i + 0.5)}
						y={y + 13}
						weight={i === active ? 700 : 400}
						fill={i === active ? "var(--text-primary)" : ink}
					>
						{item}
					</Label>
				</g>
			))}
		</>
	);
}

function Caption({
	x,
	y,
	children,
}: {
	x: number;
	y: number;
	children: string;
}) {
	return (
		<Label x={x} y={y} anchor="start" size={7} weight={700}>
			{children}
		</Label>
	);
}

// A stack of result rows, for the controls whose whole point is what happens to
// them. Usually beneath the control; beside it where the control is tall enough
// to take the width, which is what the value list is.
//
// Takes its own box rather than assuming the full plot. The value list drew its
// rows over the top of itself when this was fixed to the left margin.
function Rows({
	y,
	x = l,
	width = 128,
	kept = [0, 1, 2, 3],
	total = 4,
	blanks = -1,
}: {
	y: number;
	x?: number;
	width?: number;
	kept?: number[];
	total?: number;
	blanks?: number;
}) {
	const labelWidth = width * 0.64;
	const valueAt = x + width * 0.72;
	const valueWidth = width * 0.28;
	return (
		<>
			{Array.from({ length: total }, (_, i) => {
				const on = kept.includes(i);
				const rowY = y + i * 11;
				return (
					<g key={i} opacity={on ? 1 : 0.25}>
						<rect
							x={x}
							y={rowY}
							width={labelWidth}
							height="5"
							rx="2"
							fill={ink}
							opacity="0.5"
						/>
						{i === blanks ? (
							<rect
								x={valueAt}
								y={rowY - 1}
								width={valueWidth}
								height="7"
								rx="2"
								fill="none"
								stroke={c1}
								strokeDasharray="2 2"
							/>
						) : (
							<rect
								x={valueAt}
								y={rowY}
								width={valueWidth - (i % 3) * (valueWidth / 5)}
								height="5"
								rx="2"
								fill={c1}
								opacity="0.75"
							/>
						)}
					</g>
				);
			})}
		</>
	);
}

export function VisualRender({ type }: { type: string }) {
	return (
		<svg
			viewBox={`0 0 ${w} ${h}`}
			width="100%"
			role="presentation"
			aria-hidden="true"
			style={{ display: "block" }}
		>
			{body(type)}
		</svg>
	);
}

function body(type: string): React.ReactNode {
	switch (type) {
		// --- comparison ----------------------------------------------------
		case "barChart": {
			const values = [58, 82, 41, 69, 33];
			const slot = (r - l) / values.length;
			return (
				<>
					<Grid />
					{values.map((v, i) => {
						const height = ((b - t) * v) / 100;
						return (
							<rect
								key={i}
								x={l + slot * i + slot * 0.22}
								y={b - height}
								width={slot * 0.56}
								height={height}
								rx="2"
								fill={c1}
							/>
						);
					})}
					<XLabels items={regions} />
				</>
			);
		}

		case "horizontalBarChart": {
			const values = [88, 71, 54, 38, 22];
			const slot = (b - t) / values.length;
			return (
				<>
					<line x1={l + 26} y1={t} x2={l + 26} y2={b} stroke={line} />
					{values.map((v, i) => (
						<g key={i}>
							<Label
								x={l + 22}
								y={t + slot * (i + 0.5) + 2.5}
								anchor="end"
							>
								{regions[i]}
							</Label>
							<rect
								x={l + 27}
								y={t + slot * i + slot * 0.2}
								width={((r - l - 27) * v) / 100}
								height={slot * 0.6}
								rx="2"
								fill={c1}
							/>
						</g>
					))}
				</>
			);
		}

		case "comboChart": {
			const bars = [52, 74, 46, 65, 38, 58];
			const pts = [30, 48, 40, 72, 58, 84];
			const slot = (r - l) / bars.length;
			return (
				<>
					<Grid />
					{bars.map((v, i) => {
						const height = ((b - t) * v) / 100;
						return (
							<rect
								key={i}
								x={l + slot * i + slot * 0.24}
								y={b - height}
								width={slot * 0.52}
								height={height}
								rx="2"
								fill={c1}
								opacity="0.85"
							/>
						);
					})}
					<polyline
						points={pts
							.map(
								(v, i) =>
									`${l + slot * (i + 0.5)},${b - ((b - t) * v) / 100}`,
							)
							.join(" ")}
						fill="none"
						stroke={c3}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					{pts.map((v, i) => (
						<circle
							key={i}
							cx={l + slot * (i + 0.5)}
							cy={b - ((b - t) * v) / 100}
							r="2.4"
							fill={paper}
							stroke={c3}
							strokeWidth="1.6"
						/>
					))}
					<XLabels items={months} />
					<Legend
						items={[
							{ label: "Revenue", color: c1 },
							{ label: "Margin %", color: c3 },
						]}
					/>
				</>
			);
		}

		// --- trend ----------------------------------------------------------
		case "lineChart": {
			const a = [34, 52, 44, 68, 60, 82];
			const c = [22, 30, 38, 34, 48, 56];
			const slot = (r - l) / (a.length - 1);
			const path = (vals: number[]) =>
				vals
					.map((v, i) => `${l + slot * i},${b - ((b - t) * v) / 100}`)
					.join(" ");
			return (
				<>
					<Grid />
					<polyline
						points={path(a)}
						fill="none"
						stroke={c1}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<polyline
						points={path(c)}
						fill="none"
						stroke={c2}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					{a.map((v, i) => (
						<circle
							key={i}
							cx={l + slot * i}
							cy={b - ((b - t) * v) / 100}
							r="2.2"
							fill={c1}
						/>
					))}
					<XLabels items={months} />
					<Legend
						items={[
							{ label: "This year", color: c1 },
							{ label: "Last year", color: c2 },
						]}
					/>
				</>
			);
		}

		case "areaChart": {
			const vals = [30, 46, 40, 66, 58, 78];
			const slot = (r - l) / (vals.length - 1);
			const pts = vals.map(
				(v, i) => `${l + slot * i},${b - ((b - t) * v) / 100}`,
			);
			return (
				<>
					<Grid />
					<path
						d={`M${l},${b} L${pts.join(" L")} L${r},${b} Z`}
						fill={c1}
						opacity="0.22"
					/>
					<polyline
						points={pts.join(" ")}
						fill="none"
						stroke={c1}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<XLabels items={months} />
				</>
			);
		}

		case "waterfallChart": {
			// Opening, three movements, closing.
			const steps = [
				{ label: "Open", from: 0, to: 52, kind: "total" },
				{ label: "New", from: 52, to: 74, kind: "up" },
				{ label: "Churn", from: 74, to: 61, kind: "down" },
				{ label: "Upsell", from: 61, to: 79, kind: "up" },
				{ label: "Close", from: 0, to: 79, kind: "total" },
			];
			const slot = (r - l) / steps.length;
			const y = (v: number) => b - ((b - t) * v) / 100;
			return (
				<>
					<Grid />
					{steps.map((step, i) => {
						const top = y(Math.max(step.from, step.to));
						const height = Math.abs(y(step.from) - y(step.to));
						const fill =
							step.kind === "down"
								? "var(--danger)"
								: step.kind === "up"
									? c2
									: c1;
						return (
							<g key={step.label}>
								{i > 0 && (
									<line
										x1={l + slot * (i - 1) + slot * 0.76}
										y1={y(steps[i - 1].to)}
										x2={l + slot * i + slot * 0.24}
										y2={y(steps[i - 1].to)}
										stroke={edge}
										strokeDasharray="2 2"
									/>
								)}
								<rect
									x={l + slot * i + slot * 0.24}
									y={top}
									width={slot * 0.52}
									height={Math.max(2, height)}
									rx="2"
									fill={fill}
								/>
							</g>
						);
					})}
					<XLabels items={steps.map((s) => s.label)} />
				</>
			);
		}

		// --- composition -----------------------------------------------------
		case "pieChart":
		case "donutChart": {
			const cx = 96;
			const cy = 68;
			const radius = 50;
			const hole = type === "donutChart" ? 27 : 0;
			const slices = [
				{ label: "North", value: 38, color: c1 },
				{ label: "South", value: 27, color: c2 },
				{ label: "East", value: 21, color: c3 },
				{ label: "West", value: 14, color: c4 },
			];
			let angle = -Math.PI / 2;
			return (
				<>
					{slices.map((slice) => {
						const sweep = (slice.value / 100) * Math.PI * 2;
						const x1 = cx + radius * Math.cos(angle);
						const y1 = cy + radius * Math.sin(angle);
						const x2 = cx + radius * Math.cos(angle + sweep);
						const y2 = cy + radius * Math.sin(angle + sweep);
						const large = sweep > Math.PI ? 1 : 0;
						const d = hole
							? `M${x1} ${y1} A${radius} ${radius} 0 ${large} 1 ${x2} ${y2} L${cx + hole * Math.cos(angle + sweep)} ${cy + hole * Math.sin(angle + sweep)} A${hole} ${hole} 0 ${large} 0 ${cx + hole * Math.cos(angle)} ${cy + hole * Math.sin(angle)} Z`
							: `M${cx} ${cy} L${x1} ${y1} A${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
						angle += sweep;
						return (
							<path
								key={slice.label}
								d={d}
								fill={slice.color}
								stroke={paper}
								strokeWidth="1.5"
							/>
						);
					})}
					{hole > 0 && (
						<>
							<Label
								x={cx}
								y={cy - 1}
								size={13}
								weight={700}
								fill="var(--text-primary)"
							>
								4.2K
							</Label>
							<Label x={cx} y={cy + 9} size={6.5}>
								TOTAL
							</Label>
						</>
					)}
					{slices.map((slice, i) => (
						<g key={slice.label}>
							<rect
								x={168}
								y={30 + i * 17}
								width="8"
								height="8"
								rx="2"
								fill={slice.color}
							/>
							<Label x={181} y={37 + i * 17} anchor="start">
								{slice.label}
							</Label>
							<Label
								x={r}
								y={37 + i * 17}
								anchor="end"
								weight={600}
							>
								{slice.value}%
							</Label>
						</g>
					))}
				</>
			);
		}

		case "stackedBarChart": {
			const cols = [
				[46, 32, 22],
				[38, 41, 21],
				[52, 26, 22],
				[30, 45, 25],
				[44, 34, 22],
			];
			const colors = [c1, c2, c3];
			const slot = (r - l) / cols.length;
			return (
				<>
					<Grid ticks={["0", "50%", "100%"]} />
					{cols.map((parts, i) => {
						let y = b;
						return (
							<g key={i}>
								{parts.map((part, k) => {
									const height = ((b - t) * part) / 100;
									y -= height;
									return (
										<rect
											key={k}
											x={l + slot * i + slot * 0.22}
											y={y}
											width={slot * 0.56}
											height={height}
											fill={colors[k]}
										/>
									);
								})}
							</g>
						);
					})}
					<XLabels items={regions} />
					<Legend
						items={[
							{ label: "Direct", color: c1 },
							{ label: "Partner", color: c2 },
							{ label: "Online", color: c3 },
						]}
					/>
				</>
			);
		}

		case "treemapChart":
			return (
				<>
					<rect
						x={l}
						y={t}
						width="112"
						height="104"
						fill={c1}
						stroke={paper}
						strokeWidth="2"
					/>
					<Label
						x={l + 8}
						y={t + 18}
						anchor="start"
						size={8}
						weight={700}
						fill="var(--brand-contrast)"
					>
						North
					</Label>
					<Label
						x={l + 8}
						y={t + 29}
						anchor="start"
						size={7}
						fill="var(--brand-contrast)"
					>
						38%
					</Label>

					<rect
						x={l + 112}
						y={t}
						width="106"
						height="58"
						fill={c2}
						stroke={paper}
						strokeWidth="2"
					/>
					<Label
						x={l + 120}
						y={t + 18}
						anchor="start"
						size={8}
						weight={700}
						fill="var(--brand-contrast)"
					>
						South
					</Label>

					<rect
						x={l + 112}
						y={t + 58}
						width="60"
						height="46"
						fill={c3}
						stroke={paper}
						strokeWidth="2"
					/>
					<Label
						x={l + 118}
						y={t + 76}
						anchor="start"
						size={7}
						weight={700}
						fill="var(--brand-contrast)"
					>
						East
					</Label>

					<rect
						x={l + 172}
						y={t + 58}
						width="46"
						height="46"
						fill={c4}
						stroke={paper}
						strokeWidth="2"
					/>
					<Label
						x={l + 177}
						y={t + 76}
						anchor="start"
						size={7}
						weight={700}
						fill="var(--brand-contrast)"
					>
						West
					</Label>
				</>
			);

		case "funnelChart": {
			const stages = [
				{ label: "Visits", width: 200, value: "12.4k" },
				{ label: "Signups", width: 152, value: "5.1k" },
				{ label: "Trials", width: 104, value: "2.3k" },
				{ label: "Paid", width: 58, value: "820" },
			];
			return (
				<>
					{stages.map((stage, i) => {
						const y = t + i * 26;
						const cx = (l + r) / 2;
						return (
							<g key={stage.label}>
								<rect
									x={cx - stage.width / 2}
									y={y}
									width={stage.width}
									height="21"
									rx="2"
									fill={c1}
									opacity={1 - i * 0.16}
								/>
								<Label
									x={cx}
									y={y + 14}
									size={8}
									weight={700}
									fill="var(--brand-contrast)"
								>
									{`${stage.label}  ${stage.value}`}
								</Label>
							</g>
						);
					})}
				</>
			);
		}

		// --- distribution ----------------------------------------------------
		case "heatmapChart": {
			const rows = ["North", "South", "East"];
			const values = [
				[0.9, 0.55, 0.3, 0.7, 0.45, 0.2],
				[0.4, 0.85, 0.6, 0.25, 0.75, 0.5],
				[0.2, 0.35, 0.95, 0.5, 0.3, 0.65],
			];
			const cw = (r - l - 26) / 6;
			const ch = 28;
			return (
				<>
					{values.map((row, y) =>
						row.map((v, x) => (
							<rect
								key={`${x}-${y}`}
								x={l + 26 + x * cw + 1}
								y={t + y * ch + 1}
								width={cw - 2}
								height={ch - 2}
								rx="2"
								fill={c1}
								opacity={v}
							/>
						)),
					)}
					{rows.map((row, y) => (
						<Label
							key={row}
							x={l + 22}
							y={t + y * ch + ch / 2 + 2.5}
							anchor="end"
						>
							{row}
						</Label>
					))}
					{months.map((month, x) => (
						<Label
							key={month}
							x={l + 26 + x * cw + cw / 2}
							y={t + 3 * ch + 11}
						>
							{month}
						</Label>
					))}
				</>
			);
		}

		case "radarChart": {
			const cx = 130;
			const cy = 66;
			const axes = ["Speed", "Cost", "Quality", "Reach", "Support"];
			const shape = [0.9, 0.55, 0.78, 0.4, 0.66];
			const point = (i: number, scale: number) => {
				const a = -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
				return [
					cx + 48 * scale * Math.cos(a),
					cy + 48 * scale * Math.sin(a),
				];
			};
			return (
				<>
					{[0.33, 0.66, 1].map((ring) => (
						<polygon
							key={ring}
							points={axes
								.map((_, i) => point(i, ring).join(","))
								.join(" ")}
							fill="none"
							stroke={line}
						/>
					))}
					{axes.map((_, i) => (
						<line
							key={i}
							x1={cx}
							y1={cy}
							x2={point(i, 1)[0]}
							y2={point(i, 1)[1]}
							stroke={line}
						/>
					))}
					<polygon
						points={shape
							.map((v, i) => point(i, v).join(","))
							.join(" ")}
						fill={c1}
						opacity="0.3"
						stroke={c1}
						strokeWidth="2"
					/>
					{axes.map((axis, i) => {
						const [x, y] = point(i, 1.2);
						return (
							<Label key={axis} x={x} y={y + 2.5}>
								{axis}
							</Label>
						);
					})}
				</>
			);
		}

		// --- relationship -----------------------------------------------------
		case "scatterChart": {
			const pts = [
				[18, 30],
				[26, 44],
				[34, 38],
				[41, 58],
				[47, 50],
				[55, 66],
				[62, 59],
				[70, 78],
				[77, 70],
				[85, 88],
				[30, 22],
				[44, 33],
				[58, 41],
				[72, 52],
				[88, 63],
			];
			return (
				<>
					<Grid />
					{pts.map(([x, y], i) => (
						<circle
							key={i}
							cx={l + ((r - l) * x) / 100}
							cy={b - ((b - t) * y) / 100}
							r="3.2"
							fill={i > 9 ? c2 : c1}
							opacity="0.8"
						/>
					))}
					<XLabels items={["0", "25", "50", "75", "100"]} />
				</>
			);
		}

		// --- summary ----------------------------------------------------------
		case "kpiRow": {
			const tiles = [
				{ label: "REVENUE", value: "4.2M", delta: "+12%", up: true },
				{ label: "ORDERS", value: "18,402", delta: "+4%", up: true },
				{ label: "RETURNS", value: "2.1%", delta: "-0.3%", up: false },
			];
			const tw = (r - l - 16) / 3;
			return (
				<>
					{tiles.map((tile, i) => (
						<g key={tile.label}>
							<rect
								x={l + i * (tw + 8)}
								y={t + 18}
								width={tw}
								height="72"
								rx="4"
								fill={paper}
								stroke={line}
							/>
							<Label
								x={l + i * (tw + 8) + 10}
								y={t + 36}
								anchor="start"
								size={6.5}
								weight={700}
							>
								{tile.label}
							</Label>
							<Label
								x={l + i * (tw + 8) + 10}
								y={t + 58}
								anchor="start"
								size={16}
								weight={700}
								fill="var(--text-primary)"
							>
								{tile.value}
							</Label>
							<Label
								x={l + i * (tw + 8) + 10}
								y={t + 74}
								anchor="start"
								size={7.5}
								weight={600}
								fill={
									tile.up ? "var(--success)" : "var(--danger)"
								}
							>
								{`${tile.up ? "▲" : "▼"} ${tile.delta}`}
							</Label>
						</g>
					))}
				</>
			);
		}

		case "gauge": {
			const cx = 130;
			const cy = 96;
			const radius = 58;
			const arc = (from: number, to: number) => {
				const a1 = Math.PI + Math.PI * from;
				const a2 = Math.PI + Math.PI * to;
				return `M${cx + radius * Math.cos(a1)} ${cy + radius * Math.sin(a1)} A${radius} ${radius} 0 0 1 ${cx + radius * Math.cos(a2)} ${cy + radius * Math.sin(a2)}`;
			};
			return (
				<>
					<path
						d={arc(0, 1)}
						fill="none"
						stroke={line}
						strokeWidth="14"
						strokeLinecap="round"
					/>
					<path
						d={arc(0, 0.72)}
						fill="none"
						stroke={c1}
						strokeWidth="14"
						strokeLinecap="round"
					/>
					<Label
						x={cx}
						y={cy - 8}
						size={20}
						weight={700}
						fill="var(--text-primary)"
					>
						72%
					</Label>
					<Label x={cx} y={cy + 6} size={7}>
						OF TARGET
					</Label>
					<Label x={cx - radius} y={cy + 14}>
						0
					</Label>
					<Label x={cx + radius} y={cy + 14}>
						100
					</Label>
				</>
			);
		}

		// --- detail ------------------------------------------------------------
		case "table":
		case "matrixTable": {
			const matrix = type === "matrixTable";
			const cols = matrix
				? ["Region", "Q1", "Q2", "Q3"]
				: ["Order", "Customer", "Value", "Status"];
			const rows = matrix
				? [
						["North", "1,204", "1,388", "1,510"],
						["  Direct", "702", "810", "884"],
						["  Partner", "502", "578", "626"],
						["South", "980", "1,042", "1,176"],
						["East", "744", "812", "902"],
					]
				: [
						["ORD-1041", "Customer A", "12,400", "Open"],
						["ORD-1042", "Customer B", "8,150", "Shipped"],
						["ORD-1043", "Customer C", "21,900", "Open"],
						["ORD-1044", "Customer D", "4,220", "Held"],
						["ORD-1045", "Customer E", "16,780", "Shipped"],
					];
			const cw = (r - l) / cols.length;
			return (
				<>
					<rect
						x={l}
						y={t}
						width={r - l}
						height="16"
						fill="var(--surface-sunken)"
					/>
					{cols.map((col, i) => (
						<Label
							key={col}
							x={i === 0 ? l + 6 : l + cw * (i + 1) - 6}
							y={t + 11}
							anchor={i === 0 ? "start" : "end"}
							size={7}
							weight={700}
						>
							{col}
						</Label>
					))}
					<line x1={l} y1={t + 16} x2={r} y2={t + 16} stroke={edge} />

					{rows.map((row, y) => {
						const rowY = t + 16 + y * 19;
						const indented = row[0].startsWith("  ");
						return (
							<g key={y}>
								{y % 2 === 1 && (
									<rect
										x={l}
										y={rowY}
										width={r - l}
										height="19"
										fill="var(--surface-sunken)"
										opacity="0.6"
									/>
								)}
								{matrix && !indented && (
									<path
										d={`M${l + 5} ${rowY + 7} l3.2 3 l-3.2 3`}
										fill="none"
										stroke={ink}
										strokeWidth="1.4"
										strokeLinecap="round"
										strokeLinejoin="round"
										transform={
											y === 0
												? `rotate(90 ${l + 6.6} ${rowY + 10})`
												: undefined
										}
									/>
								)}
								{row.map((cell, i) => (
									<Label
										key={i}
										x={
											i === 0
												? l + (matrix ? 14 : 6)
												: l + cw * (i + 1) - 6
										}
										y={rowY + 13}
										anchor={i === 0 ? "start" : "end"}
										size={7.5}
										fill={
											i === 0
												? "var(--text-primary)"
												: ink
										}
									>
										{cell.trim()}
									</Label>
								))}
								<line
									x1={l}
									y1={rowY + 19}
									x2={r}
									y2={rowY + 19}
									stroke={line}
								/>
							</g>
						);
					})}
				</>
			);
		}

		case "definitionList": {
			const pairs = [
				["Account", "Customer A"],
				["Owner", "Team North"],
				["Opened", "12 Mar 2024"],
				["Terms", "Net 30"],
				["Credit limit", "250,000"],
			];
			return (
				<>
					{pairs.map(([key, value], i) => (
						<g key={key}>
							<Label
								x={l}
								y={t + 16 + i * 21}
								anchor="start"
								size={7}
							>
								{key}
							</Label>
							<Label
								x={r}
								y={t + 16 + i * 21}
								anchor="end"
								size={8.5}
								weight={600}
								fill="var(--text-primary)"
							>
								{value}
							</Label>
							<line
								x1={l}
								y1={t + 21 + i * 21}
								x2={r}
								y2={t + 21 + i * 21}
								stroke={line}
							/>
						</g>
					))}
				</>
			);
		}

		case "entityHeader": {
			const attrs = [
				["STATUS", "Active"],
				["TIER", "Enterprise"],
				["REGION", "North"],
				["SINCE", "2019"],
			];
			const aw = (r - l) / 4;
			return (
				<>
					<Label
						x={l}
						y={t + 20}
						anchor="start"
						size={17}
						weight={700}
						fill="var(--text-primary)"
					>
						Customer A
					</Label>
					<Label x={l} y={t + 34} anchor="start" size={7.5}>
						Account · ID-1042
					</Label>
					<line x1={l} y1={t + 44} x2={r} y2={t + 44} stroke={line} />
					{attrs.map(([key, value], i) => (
						<g key={key}>
							<Label
								x={l + aw * i}
								y={t + 62}
								anchor="start"
								size={6.5}
								weight={700}
							>
								{key}
							</Label>
							<Label
								x={l + aw * i}
								y={t + 76}
								anchor="start"
								size={9}
								weight={600}
								fill="var(--text-primary)"
							>
								{value}
							</Label>
						</g>
					))}
				</>
			);
		}

		// --- text --------------------------------------------------------------
		case "textPanel":
			return (
				<>
					<Label
						x={l}
						y={t + 16}
						anchor="start"
						size={11}
						weight={700}
						fill="var(--text-primary)"
					>
						How this is counted
					</Label>
					{[0, 1, 2, 3].map((i) => (
						<rect
							key={i}
							x={l}
							y={t + 28 + i * 13}
							width={i === 3 ? 118 : r - l}
							height="6"
							rx="3"
							fill={ink}
							opacity="0.32"
						/>
					))}
					<rect
						x={l}
						y={t + 28}
						width="4"
						height="45"
						rx="2"
						fill={c1}
						opacity="0"
					/>
				</>
			);

		case "sectionHeader":
			return (
				<>
					<Label
						x={l}
						y={t + 50}
						anchor="start"
						size={15}
						weight={700}
						fill="var(--text-primary)"
					>
						Fulfilment
					</Label>
					<line
						x1={l}
						y1={t + 60}
						x2={r}
						y2={t + 60}
						stroke={c1}
						strokeWidth="2"
					/>
					<Label x={l} y={t + 76} anchor="start" size={7.5}>
						Everything below this heading is about getting orders
						out.
					</Label>
				</>
			);

		case "blockedNotice":
			return (
				<>
					<rect
						x={l}
						y={t + 20}
						width={r - l}
						height="66"
						rx="4"
						fill={c1}
						opacity="0.1"
					/>
					<rect
						x={l}
						y={t + 20}
						width={r - l}
						height="66"
						rx="4"
						fill="none"
						stroke={c1}
						strokeDasharray="4 3"
					/>
					<circle
						cx={l + 22}
						cy={t + 53}
						r="10"
						fill={c1}
						opacity="0.8"
					/>
					<Label
						x={l + 22}
						y={t + 57}
						size={12}
						weight={700}
						fill="var(--brand-contrast)"
					>
						!
					</Label>
					<Label
						x={l + 40}
						y={t + 48}
						anchor="start"
						size={9}
						weight={700}
						fill="var(--text-primary)"
					>
						Waiting on the returns feed
					</Label>
					<Label x={l + 40} y={t + 62} anchor="start" size={7.5}>
						Expected once the nightly load lands.
					</Label>
				</>
			);

		// --- layout --------------------------------------------------------------
		case "group":
			return (
				<>
					<rect
						x={l}
						y={t}
						width={r - l}
						height="104"
						rx="5"
						fill="var(--surface-sunken)"
						stroke={edge}
					/>
					<Label
						x={l + 8}
						y={t + 14}
						anchor="start"
						size={7.5}
						weight={700}
					>
						Regional detail
					</Label>
					<rect
						x={l + 8}
						y={t + 22}
						width="98"
						height="72"
						rx="3"
						fill={paper}
						stroke={line}
					/>
					{[38, 62, 46, 70].map((v, i) => (
						<rect
							key={i}
							x={l + 16 + i * 22}
							y={t + 86 - (v * 52) / 100}
							width="14"
							height={(v * 52) / 100}
							rx="1.5"
							fill={c1}
						/>
					))}
					<rect
						x={l + 114}
						y={t + 22}
						width="96"
						height="33"
						rx="3"
						fill={paper}
						stroke={line}
					/>
					<Label
						x={l + 122}
						y={t + 44}
						anchor="start"
						size={13}
						weight={700}
						fill="var(--text-primary)"
					>
						4.2M
					</Label>
					<rect
						x={l + 114}
						y={t + 61}
						width="96"
						height="33"
						rx="3"
						fill={paper}
						stroke={line}
					/>
					<Label
						x={l + 122}
						y={t + 83}
						anchor="start"
						size={13}
						weight={700}
						fill="var(--text-primary)"
					>
						18,402
					</Label>
				</>
			);

		// --- controls ---------------------------------------------------------
		case "dropdownFilter":
			return (
				<>
					<Caption x={l} y={t + 8}>
						REGION
					</Caption>
					<Field x={l} y={t + 14} width={120}>
						<Label x={l + 8} y={t + 26} anchor="start" size={8}>
							Value A, B
						</Label>
						<Chevron x={l + 104} y={t + 21} />
					</Field>
					<Rows y={t + 48} kept={[0, 2]} />
				</>
			);

		case "bulkFilter":
			return (
				<>
					<Caption x={l} y={t + 8}>
						FIELD
					</Caption>
					<rect
						x={l}
						y={t + 14}
						width={108}
						height="84"
						rx="3"
						fill={paper}
						stroke={edge}
					/>
					{["Value A", "Value B", "Value C", "Value D"].map(
						(name, i) => (
							<g key={name}>
								<rect
									x={l + 8}
									y={t + 24 + i * 19}
									width="9"
									height="9"
									rx="2"
									fill={i < 2 ? c1 : "none"}
									stroke={i < 2 ? c1 : edge}
								/>
								{i < 2 && (
									<path
										d={`M${l + 10} ${t + 28.5 + i * 19} l1.8 1.8 l3.4 -3.6`}
										fill="none"
										stroke="var(--brand-contrast)"
										strokeWidth="1.6"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								)}
								<Label
									x={l + 23}
									y={t + 32 + i * 19}
									anchor="start"
									size={8}
								>
									{name}
								</Label>
							</g>
						),
					)}
					<Rows
						x={l + 120}
						width={r - l - 120}
						y={t + 26}
						kept={[0, 1]}
						total={4}
					/>
				</>
			);

		case "searchFilter":
			return (
				<>
					<Caption x={l} y={t + 8}>
						SEARCH
					</Caption>
					<Field x={l} y={t + 14} width={148} height={20}>
						<circle
							cx={l + 14}
							cy={t + 24}
							r="4.4"
							fill="none"
							stroke={c1}
							strokeWidth="1.6"
						/>
						<line
							x1={l + 17.5}
							y1={t + 27.5}
							x2={l + 21}
							y2={t + 31}
							stroke={c1}
							strokeWidth="1.6"
							strokeLinecap="round"
						/>
						<Label x={l + 28} y={t + 27} anchor="start" size={8}>
							cust
						</Label>
					</Field>
					<Rows y={t + 48} kept={[0, 2]} />
				</>
			);

		case "filterBar": {
			const fields = ["REGION", "CHANNEL", "STATUS"];
			const fw = (r - l - 12) / 3;
			return (
				<>
					{fields.map((field, i) => (
						<g key={field}>
							<Caption x={l + i * (fw + 6)} y={t + 8}>
								{field}
							</Caption>
							<Field x={l + i * (fw + 6)} y={t + 14} width={fw}>
								<Label
									x={l + i * (fw + 6) + 7}
									y={t + 26}
									anchor="start"
									size={7.5}
								>
									All
								</Label>
								<Chevron
									x={l + i * (fw + 6) + fw - 15}
									y={t + 21}
								/>
							</Field>
						</g>
					))}
					<Rows y={t + 48} kept={[0, 1, 3]} />
				</>
			);
		}

		case "dateRangeFilter":
			return (
				<>
					<Caption x={l} y={t + 8}>
						ORDER DATE
					</Caption>
					<Field x={l} y={t + 14} width={82}>
						<Label x={l + 8} y={t + 26} anchor="start" size={8}>
							1 Jan 2025
						</Label>
					</Field>
					<Label x={l + 90} y={t + 26} size={8}>
						to
					</Label>
					<Field x={l + 98} y={t + 14} width={82}>
						<Label x={l + 106} y={t + 26} anchor="start" size={8}>
							31 Mar 2025
						</Label>
					</Field>
					{["7d", "30d", "QTD", "YTD"].map((preset, i) => (
						<g key={preset}>
							<rect
								x={l + i * 34}
								y={t + 40}
								width="30"
								height="15"
								rx="7.5"
								fill={i === 2 ? c1 : "none"}
								stroke={i === 2 ? c1 : edge}
							/>
							<Label
								x={l + i * 34 + 15}
								y={t + 50}
								size={7}
								weight={600}
								fill={i === 2 ? "var(--brand-contrast)" : ink}
							>
								{preset}
							</Label>
						</g>
					))}
					<Rows y={t + 66} kept={[0, 1, 2]} total={3} />
				</>
			);

		case "numericRangeFilter":
			return (
				<>
					<Caption x={l} y={t + 8}>
						ORDER VALUE
					</Caption>
					<line
						x1={l + 6}
						y1={t + 26}
						x2={r - 6}
						y2={t + 26}
						stroke={edge}
						strokeWidth="3"
						strokeLinecap="round"
					/>
					<line
						x1={l + 62}
						y1={t + 26}
						x2={r - 58}
						y2={t + 26}
						stroke={c1}
						strokeWidth="3"
						strokeLinecap="round"
					/>
					<circle
						cx={l + 62}
						cy={t + 26}
						r="6"
						fill={paper}
						stroke={c1}
						strokeWidth="2.4"
					/>
					<circle
						cx={r - 58}
						cy={t + 26}
						r="6"
						fill={paper}
						stroke={c1}
						strokeWidth="2.4"
					/>
					<Label x={l + 62} y={t + 44} size={7.5} weight={600}>
						2,500
					</Label>
					<Label x={r - 58} y={t + 44} size={7.5} weight={600}>
						18,000
					</Label>
					<Rows y={t + 58} kept={[1, 2]} />
				</>
			);

		case "thresholdControl":
			return (
				<>
					<Caption x={l} y={t + 8}>
						ORDER VALUE IS AT LEAST
					</Caption>
					<line
						x1={l + 6}
						y1={t + 26}
						x2={r - 6}
						y2={t + 26}
						stroke={edge}
						strokeWidth="3"
						strokeLinecap="round"
					/>
					<line
						x1={l + 6}
						y1={t + 26}
						x2={l + 118}
						y2={t + 26}
						stroke={c1}
						strokeWidth="3"
						strokeLinecap="round"
					/>
					<circle
						cx={l + 118}
						cy={t + 26}
						r="6"
						fill={paper}
						stroke={c1}
						strokeWidth="2.4"
					/>
					<Label
						x={l + 118}
						y={t + 45}
						size={9}
						weight={700}
						fill="var(--text-primary)"
					>
						5,000
					</Label>
					<Rows y={t + 58} kept={[0, 1]} />
				</>
			);

		case "toggleFilter":
			return (
				<>
					<rect
						x={l}
						y={t + 14}
						width="34"
						height="19"
						rx="9.5"
						fill={c1}
					/>
					<circle cx={l + 24} cy={t + 23.5} r="7" fill={paper} />
					<Label
						x={l + 44}
						y={t + 27}
						anchor="start"
						size={9}
						weight={600}
						fill="var(--text-primary)"
					>
						Open orders only
					</Label>
					<Rows y={t + 48} kept={[0, 2, 3]} />
				</>
			);

		case "presenceFilter":
			return (
				<>
					<Caption x={l} y={t + 8}>
						DELIVERY NOTE
					</Caption>
					<Segmented
						x={l}
						y={t + 13}
						width={168}
						items={["Any", "Has value", "Blank"]}
						active={2}
					/>
					<Rows y={t + 48} kept={[1, 3]} blanks={1} />
				</>
			);

		case "dimensionSwitch":
			return (
				<>
					<Caption x={l} y={t + 8}>
						BREAK DOWN BY
					</Caption>
					<Segmented
						x={l}
						y={t + 13}
						width={190}
						items={["Region", "Channel", "Product"]}
						active={1}
					/>
					{[54, 78, 40, 66].map((v, i) => (
						<rect
							key={i}
							x={l + 6 + i * 44}
							y={t + 100 - (v * 52) / 100}
							width="30"
							height={(v * 52) / 100}
							rx="2"
							fill={c1}
						/>
					))}
					<line
						x1={l}
						y1={t + 100}
						x2={r}
						y2={t + 100}
						stroke={edge}
					/>
				</>
			);

		case "periodSwitch":
			return (
				<>
					<Caption x={l} y={t + 8}>
						PERIOD
					</Caption>
					<Segmented
						x={l}
						y={t + 13}
						width={166}
						items={["Month", "Quarter", "Year"]}
						active={0}
					/>
					<polyline
						points={[28, 46, 38, 62, 54, 80]
							.map(
								(v, i) =>
									`${l + i * 42 + 6},${t + 100 - (v * 52) / 100}`,
							)
							.join(" ")}
						fill="none"
						stroke={c1}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<line
						x1={l}
						y1={t + 100}
						x2={r}
						y2={t + 100}
						stroke={edge}
					/>
				</>
			);

		default:
			return (
				<rect
					x={l}
					y={t}
					width={r - l}
					height={b - t}
					rx="4"
					fill="none"
					stroke={line}
					strokeDasharray="4 3"
				/>
			);
	}
}
