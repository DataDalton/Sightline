// Generated from lib/visuals/svgSanitize.ts by "npm run build:scripts". Do not edit.
// Making an uploaded SVG safe to put in the page, and able to follow the theme.
//
// A logo that adapts to light and dark has to be part of the document: an
// <img> is an opaque box, so `currentColor` means nothing inside it and the
// mark keeps whatever colour it was drawn in. Putting the markup in the
// document is what makes theming possible and is also what makes it dangerous,
// because SVG is an executable format: it carries script elements, event
// handler attributes, external references and entity declarations.
//
// So this rebuilds the file from an allow-list rather than removing the parts
// known to be bad. A deny-list is a bet that the list is complete, and the
// history of SVG sanitisers is a history of that bet being lost. Anything not
// named here does not survive, including anything added to the format later.
// Shape and structure. Everything that draws, nothing that acts.
const allowedElements = new Set([
    "svg",
    "g",
    "path",
    "circle",
    "ellipse",
    "line",
    "polygon",
    "polyline",
    "rect",
    "defs",
    "lineargradient",
    "radialgradient",
    "stop",
    "clippath",
    "mask",
    "title",
    "desc",
    "text",
    "tspan",
]);
// Presentation and geometry. No href of any kind: an external reference is a
// request the page did not intend to make, and a local one is a way to reach
// content this never inspected.
const allowedAttributes = new Set([
    "d",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x",
    "x1",
    "x2",
    "y",
    "y1",
    "y2",
    "width",
    "height",
    "points",
    "transform",
    "viewbox",
    "preserveaspectratio",
    "fill",
    "fill-rule",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "stroke-opacity",
    "opacity",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientunits",
    "gradienttransform",
    "clip-path",
    "clip-rule",
    "mask",
    "id",
    "font-size",
    "font-family",
    "font-weight",
    "text-anchor",
    "xmlns",
]);
// Colour values that mean "whatever the surrounding text is". Kept as is when
// adapting, since they are already the answer.
const inheritedColours = new Set(["currentcolor", "none", "transparent"]);
function isSafeValue(value) {
    const lowered = value.toLowerCase();
    // A url() reference can point anywhere, and a data or script scheme is a
    // way to run something. Local gradient references are the cost of this
    // rule; a flat mark is a fair trade for not having to be right about
    // every scheme a browser accepts.
    return (!lowered.includes("javascript:") &&
        !lowered.includes("data:") &&
        !lowered.includes("url(") &&
        !lowered.includes("&#") &&
        !lowered.includes("<"));
}
export function sanitizeSvg(input, options = {}) {
    if (typeof input !== "string" || input.trim() === "")
        return null;
    // Declarations and processing instructions are dropped whole. An entity
    // declaration is how an SVG reads a file off the server that rendered it.
    const body = input
        .replace(/<\?[\s\S]*?\?>/g, "")
        .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "");
    if (!/<svg[\s>]/i.test(body))
        return null;
    const removedElements = new Set();
    const removedAttributes = new Set();
    const out = [];
    // Contents of a disallowed element go with it. Without this, dropping a
    // <script> tag would leave its body behind as text.
    let skipDepth = 0;
    let skipping = null;
    const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
    let match;
    while ((match = tagPattern.exec(body)) !== null) {
        const raw = match[0];
        const name = match[1].toLowerCase();
        const attributeText = match[2] ?? "";
        const closing = raw.startsWith("</");
        const selfClosing = raw.endsWith("/>");
        if (skipping) {
            if (name === skipping) {
                if (closing)
                    skipDepth--;
                else if (!selfClosing)
                    skipDepth++;
                if (skipDepth <= 0)
                    skipping = null;
            }
            continue;
        }
        if (!allowedElements.has(name)) {
            removedElements.add(name);
            if (!closing && !selfClosing) {
                skipping = name;
                skipDepth = 1;
            }
            continue;
        }
        if (closing) {
            out.push(`</${name}>`);
            continue;
        }
        const attributes = [];
        const attributePattern = /([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let attribute;
        while ((attribute = attributePattern.exec(attributeText)) !== null) {
            const key = attribute[1].toLowerCase();
            const value = attribute[3] ?? attribute[4] ?? "";
            if (!allowedAttributes.has(key) || !isSafeValue(value)) {
                removedAttributes.add(key);
                continue;
            }
            // Colours give way to the surrounding text, which is the whole
            // mechanism: one file, either theme, no second upload.
            if (options.adaptive &&
                (key === "fill" || key === "stroke" || key === "stop-color") &&
                !inheritedColours.has(value.trim().toLowerCase())) {
                attributes.push(`${key}="currentColor"`);
                continue;
            }
            attributes.push(`${key}="${value.replace(/"/g, "&quot;")}"`);
        }
        // The root carries the inheritance. A file whose colour lives on a
        // group rather than on each shape would otherwise keep it.
        if (name === "svg" && options.adaptive) {
            if (!attributes.some((a) => a.startsWith("fill="))) {
                attributes.push('fill="currentColor"');
            }
        }
        const rendered = attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
        out.push(selfClosing ? `<${name}${rendered}/>` : `<${name}${rendered}>`);
    }
    const markup = out.join("");
    if (!markup.startsWith("<svg"))
        return null;
    return {
        markup,
        removedElements: [...removedElements],
        removedAttributes: [...removedAttributes],
    };
}
