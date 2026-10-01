"use client";

import type { ReactNode } from "react";
import {
	arrowEnds,
	arrowRoutes,
	lineStyles,
	noteColors,
	shapeKinds,
	textSizes,
	type BoardItem,
	type BoardLink,
	type ColorName,
	type ItemStyle,
	type NoteColor,
	type ShapeKind,
} from "../../lib/boards/definition";
import { styleOf, swatchOf, swatches } from "./palette";
import styles from "./Boards.module.css";

// The panel a double click opens, showing how the selected shape, note, text or
// arrow looks. Every control writes straight to the board, so a change shows
// at once and each one can be undone.

const shapeNames: Record<ShapeKind, string> = {
	rectangle: "Box",
	rounded: "Rounded",
	ellipse: "Ellipse",
	diamond: "Diamond",
};

const routeNames = {
	straight: "Straight",
	orthogonal: "Right angles",
	curved: "Curved",
} as const;

const endNames = {
	end: "One end",
	both: "Both ends",
	none: "No heads",
} as const;
const lineNames = {
	solid: "Solid",
	dashed: "Dashed",
	dotted: "Dotted",
} as const;
const sizeNames = { small: "S", medium: "M", large: "L", title: "XL" } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className={styles.formatRow}>
			<span className={styles.formatLabel}>{label}</span>
			<div className={styles.formatControl}>{children}</div>
		</div>
	);
}

// Buttons for one choice among a few, shown side by side.
function Choice<T extends string>({
	value,
	options,
	names,
	onPick,
	label,
}: {
	value: T;
	options: readonly T[];
	names: Record<T, ReactNode>;
	onPick: (next: T) => void;
	label: string;
}) {
	return (
		<div className={styles.segmented} role="radiogroup" aria-label={label}>
			{options.map((option) => (
				<button
					key={option}
					type="button"
					role="radio"
					aria-checked={value === option}
					data-on={value === option || undefined}
					className={styles.segment}
					onClick={() => onPick(option)}
				>
					{names[option]}
				</button>
			))}
		</div>
	);
}

function Colors({
	value,
	onPick,
	label,
	allowNone,
}: {
	value: ColorName | undefined;
	onPick: (next: ColorName) => void;
	label: string;
	allowNone?: boolean;
}) {
	const options: ColorName[] = [
		...(allowNone ? (["none"] as ColorName[]) : []),
		"default",
		...swatches,
	];
	return (
		<div className={styles.colorRow} role="radiogroup" aria-label={label}>
			{options.map((name) => (
				<button
					key={name}
					type="button"
					role="radio"
					aria-checked={(value ?? "default") === name}
					aria-label={name === "default" ? "Theme colour" : name}
					title={name === "default" ? "Theme colour" : name}
					data-on={(value ?? "default") === name || undefined}
					data-kind={name}
					className={styles.colorSwatch}
					style={{ background: swatchOf(name) }}
					onClick={() => onPick(name)}
				/>
			))}
		</div>
	);
}

function TextControls({
	style,
	onStyle,
}: {
	style: Required<ItemStyle>;
	onStyle: (patch: Partial<ItemStyle>) => void;
}) {
	return (
		<>
			<Row label="Text size">
				<Choice
					label="Text size"
					value={style.textSize}
					options={textSizes}
					names={sizeNames}
					onPick={(textSize) => onStyle({ textSize })}
				/>
			</Row>
			<Row label="Emphasis">
				<div className={styles.segmented}>
					<button
						type="button"
						className={styles.segment}
						aria-pressed={style.bold}
						data-on={style.bold || undefined}
						onClick={() => onStyle({ bold: !style.bold })}
					>
						<strong>B</strong>
					</button>
					<button
						type="button"
						className={styles.segment}
						aria-pressed={style.italic}
						data-on={style.italic || undefined}
						onClick={() => onStyle({ italic: !style.italic })}
					>
						<em>I</em>
					</button>
				</div>
			</Row>
			<Row label="Align">
				<Choice
					label="Align across"
					value={style.align}
					options={["left", "center", "right"] as const}
					names={{ left: "Left", center: "Centre", right: "Right" }}
					onPick={(align) => onStyle({ align })}
				/>
			</Row>
			<Row label="Place">
				<Choice
					label="Place up and down"
					value={style.valign}
					options={["top", "middle", "bottom"] as const}
					names={{ top: "Top", middle: "Middle", bottom: "Bottom" }}
					onPick={(valign) => onStyle({ valign })}
				/>
			</Row>
			<Row label="Text colour">
				<Colors
					label="Text colour"
					value={style.textColor}
					onPick={(textColor) => onStyle({ textColor })}
				/>
			</Row>
		</>
	);
}

export function ItemFormat({
	item,
	onStyle,
	onShape,
	onNoteColor,
	onClose,
}: {
	item: BoardItem;
	onStyle: (patch: Partial<ItemStyle>) => void;
	onShape: (shape: ShapeKind) => void;
	onNoteColor: (color: NoteColor) => void;
	onClose: () => void;
}) {
	const style = styleOf(item);
	const title =
		item.kind === "shape"
			? "Shape"
			: item.kind === "note"
				? "Note"
				: "Text";
	return (
		<aside
			className={styles.formatPanel}
			aria-label={`Format the ${title.toLowerCase()}`}
		>
			<header className={styles.formatHead}>
				<h2 className={styles.formatTitle}>{title}</h2>
				<button
					type="button"
					className={styles.formatClose}
					onClick={onClose}
					aria-label="Close formatting"
				>
					×
				</button>
			</header>

			{item.kind === "shape" && (
				<section className={styles.formatSection}>
					<Row label="Shape">
						<Choice
							label="Shape"
							value={item.shape ?? "rectangle"}
							options={shapeKinds}
							names={shapeNames}
							onPick={onShape}
						/>
					</Row>
					<Row label="Fill">
						<Colors
							label="Fill"
							allowNone
							value={style.fill}
							onPick={(fill) => onStyle({ fill })}
						/>
					</Row>
					<Row label="Border">
						<Colors
							label="Border colour"
							allowNone
							value={style.stroke}
							onPick={(stroke) => onStyle({ stroke })}
						/>
					</Row>
					<Row label="Border width">
						<div className={styles.stepper}>
							<input
								type="range"
								min={0}
								max={12}
								step={1}
								value={style.strokeWidth}
								onChange={(e) =>
									onStyle({
										strokeWidth: Number(e.target.value),
									})
								}
								aria-label="Border width"
							/>
							<span className={styles.stepperValue}>
								{style.strokeWidth}px
							</span>
						</div>
					</Row>
					<Row label="Border style">
						<Choice
							label="Border style"
							value={style.strokeStyle}
							options={lineStyles}
							names={lineNames}
							onPick={(strokeStyle) => onStyle({ strokeStyle })}
						/>
					</Row>
				</section>
			)}

			{item.kind === "note" && (
				<section className={styles.formatSection}>
					<Row label="Colour">
						<div className={styles.colorRow}>
							{noteColors.map((color) => (
								<button
									key={color}
									type="button"
									className={styles.swatch}
									data-color={color}
									data-on={item.color === color || undefined}
									aria-label={`${color} note`}
									onClick={() => onNoteColor(color)}
								/>
							))}
						</div>
					</Row>
				</section>
			)}

			<section className={styles.formatSection}>
				<TextControls style={style} onStyle={onStyle} />
			</section>
		</aside>
	);
}

export function LinkFormat({
	link,
	onChange,
	onClose,
}: {
	link: BoardLink;
	onChange: (patch: Partial<BoardLink>) => void;
	onClose: () => void;
}) {
	return (
		<aside className={styles.formatPanel} aria-label="Format the arrow">
			<header className={styles.formatHead}>
				<h2 className={styles.formatTitle}>Arrow</h2>
				<button
					type="button"
					className={styles.formatClose}
					onClick={onClose}
					aria-label="Close formatting"
				>
					×
				</button>
			</header>
			<section className={styles.formatSection}>
				<Row label="Route">
					<Choice
						label="Route"
						value={link.route ?? "straight"}
						options={arrowRoutes}
						names={routeNames}
						onPick={(route) => onChange({ route })}
					/>
				</Row>
				<Row label="Line">
					<Choice
						label="Line"
						value={link.line ?? "solid"}
						options={lineStyles}
						names={lineNames}
						onPick={(line) => onChange({ line })}
					/>
				</Row>
				<Row label="Heads">
					<Choice
						label="Arrowheads"
						value={link.ends ?? "end"}
						options={arrowEnds}
						names={endNames}
						onPick={(ends) => onChange({ ends })}
					/>
				</Row>
				<Row label="Motion">
					<Choice
						label="Motion"
						value={link.flow ? "flow" : "still"}
						options={["still", "flow"] as const}
						names={{ still: "Still", flow: "Flowing" }}
						onPick={(motion) =>
							onChange({ flow: motion === "flow" })
						}
					/>
				</Row>
				<Row label="Width">
					<div className={styles.stepper}>
						<input
							type="range"
							min={1}
							max={8}
							step={1}
							value={link.width ?? 2}
							onChange={(e) =>
								onChange({ width: Number(e.target.value) })
							}
							aria-label="Arrow width"
						/>
						<span className={styles.stepperValue}>
							{link.width ?? 2}px
						</span>
					</div>
				</Row>
				<Row label="Colour">
					<Colors
						label="Arrow colour"
						value={link.color}
						onPick={(color) => onChange({ color })}
					/>
				</Row>
				<Row label="Label">
					<input
						className={styles.input}
						value={link.label ?? ""}
						maxLength={200}
						placeholder="Optional"
						onChange={(e) => onChange({ label: e.target.value })}
						aria-label="Arrow label"
					/>
				</Row>
			</section>
		</aside>
	);
}
