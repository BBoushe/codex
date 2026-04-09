/**
 * @fileoverview Pure D3 module for the Hierarchical Edge Bundling visualization.
 *
 * Owns the SVG DOM entirely — React only provides a container <div>.
 * The three exported functions follow the init / update / destroy lifecycle:
 *
 *   const instance = initHeb(container, data, options)
 *   updateHeb(instance, data, options)   // on filter/color changes
 *   destroyHeb(instance)                 // on unmount
 */

import * as d3 from "d3";
import type {
	HierarchyResponse,
	HierarchyNode,
	HierarchyEdge,
	HebOptions,
	ShapeMode,
} from "@/types/graph";
import {
	moduleColor,
	EDGE_TYPE_COLORS,
	churnColor,
	doaColor,
} from "@/lib/colors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LayoutLeaf {
	id: string;
	name: string;
	module: string;
	node: HierarchyNode;
	x: number;
	y: number;
	labelX: number;
	labelRotate: number;
	textAnchor: "start" | "end" | "middle";
	flipText: boolean;
	pointNode?: d3.HierarchyPointNode<HierarchyNode>;
}

export interface HebInstance {
	svg: SVGSVGElement;
	container: HTMLElement;
	resizeObserver: ResizeObserver;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialises the HEB visualization inside a container element.
 * Attaches a ResizeObserver to re-render when the container is resized.
 */
export function initHeb(
	container: HTMLElement,
	data: HierarchyResponse,
	options: HebOptions,
): HebInstance {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.style.width = "100%";
	svg.style.height = "100%";
	container.appendChild(svg);

	render(svg, container, data, options);

	const resizeObserver = new ResizeObserver(() => {
		render(svg, container, data, options);
	});
	resizeObserver.observe(container);

	return { svg, container, resizeObserver };
}

/**
 * Re-renders the visualization with new data or options.
 * Clears the SVG and redraws from scratch — acceptable for graphs up to ~5k nodes.
 */
export function updateHeb(
	instance: HebInstance,
	data: HierarchyResponse,
	options: HebOptions,
): void {
	render(instance.svg, instance.container, data, options);
}

/**
 * Removes the SVG and disconnects the ResizeObserver.
 */
export function destroyHeb(instance: HebInstance): void {
	instance.resizeObserver.disconnect();
	instance.svg.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core render function
// ─────────────────────────────────────────────────────────────────────────────

function render(
	svgEl: SVGSVGElement,
	container: HTMLElement,
	data: HierarchyResponse,
	options: HebOptions,
): void {
	const width = container.clientWidth || 800;
	const height = container.clientHeight || 600;
	const radius = Math.min(width, height) * 0.42;

	// Read theme-aware colors from CSS variables
	const styles = getComputedStyle(container);
	const labelColor =
		styles.getPropertyValue("--color-text-muted").trim() || "#8892a4";
	const strokeColor =
		styles.getPropertyValue("--color-background").trim() || "#0f1117";

	// Clear previous render
	d3.select(svgEl).selectAll("*").remove();

	const svg = d3
		.select(svgEl)
		.attr("viewBox", `${-width / 2} ${-height / 2} ${width} ${height}`);

	// ── Build D3 hierarchy ──────────────────────────────────────────────────

	const root = d3
		.hierarchy<HierarchyNode>(data.tree, (d) => d.children)
		.sort((a, b) => d3.ascending(a.data.name, b.data.name));
	const leaves = buildLayoutLeaves(root, options.shapeMode, radius);

	if (leaves.length === 0) {
		return;
	}

	// Build a map from nodeId → leaf node for edge drawing
	const leafById = new Map<string, LayoutLeaf>();
	for (const leaf of leaves) {
		leafById.set(leaf.id, leaf);
	}

	// ── Filter edges ────────────────────────────────────────────────────────

	const visibleEdges = filterEdges(data.edges, options, leafById);

	// ── Draw edges ──────────────────────────────────────────────────────────

	const lineGenerator = d3
		.lineRadial<d3.HierarchyPointNode<HierarchyNode>>()
		.curve(d3.curveBundle.beta(0.85))
		.angle((d) => d.x)
		.radius((d) => d.y);

	const graphGroup = svg
		.append("g")
		.attr("class", "graph-root")
		.attr("transform", buildFocusTransform(leaves, options));

	const edgeGroup = graphGroup.append("g").attr("class", "edges");

	const edgePaths = edgeGroup
		.selectAll("path")
		.data(visibleEdges)
		.join("path")
		.attr("class", "edge")
		.attr("fill", "none")
		.attr("stroke-width", 1)
		.attr("stroke-opacity", 0.4)
		.attr("d", (d) => {
			const source = leafById.get(d.source);
			const target = leafById.get(d.target);
			if (!source || !target) return "";

			if (
				(options.shapeMode === "cluster" || options.shapeMode === "tree") &&
				source.pointNode &&
				target.pointNode
			) {
				const pathNodes = source.pointNode
					.path(target.pointNode)
					.filter(
						(n): n is d3.HierarchyPointNode<HierarchyNode> =>
							"x" in n && "y" in n,
					);
				return lineGenerator(pathNodes) ?? "";
			}

			if (options.shapeMode === "arc") {
				const arcHeight = Math.abs(source.x - target.x) * 0.35;
				const controlY = Math.min(source.y, target.y) - arcHeight;
				return `M${source.x},${source.y} C${source.x},${controlY} ${target.x},${controlY} ${target.x},${target.y}`;
			}

			return `M${source.x},${source.y} L${target.x},${target.y}`;
		})
		.attr(
			"stroke",
			(d) => EDGE_TYPE_COLORS[d.type] ?? EDGE_TYPE_COLORS["default"]!,
		);

	// ── Draw nodes ──────────────────────────────────────────────────────────

	const nodeGroup = graphGroup.append("g").attr("class", "nodes");

	nodeGroup
		.selectAll("g")
		.data(leaves)
		.join("g")
		.attr("transform", (d) => {
			const translate = `translate(${d.x},${d.y})`;
			return `${translate} rotate(${d.labelRotate})`;
		})
		.each(function (d) {
			const g = d3.select(this);
			const color = nodeColor(d.node, options);

			// Circle
			g.append("circle")
				.attr("r", 4)
				.attr("fill", color)
				.attr("stroke", strokeColor)
				.attr("stroke-width", 1.5)
				.attr("cursor", "pointer");

			// Label
			g.append("text")
				.attr("x", d.labelX)
				.attr("text-anchor", d.textAnchor)
				.attr("dominant-baseline", "central")
				.attr("font-size", "9px")
				.attr("fill", labelColor)
				.attr("cursor", "pointer")
				.attr("transform", d.flipText ? "rotate(180)" : "")
				.text(truncate(d.name, 20));
		})
		.on("mouseenter", function (_event, d) {
			// Highlight connected edges
			const nodeId = d.id;
			edgePaths
				.attr("stroke-opacity", (e) =>
					e.source === nodeId || e.target === nodeId ? 0.9 : 0.04,
				)
				.attr("stroke-width", (e) =>
					e.source === nodeId || e.target === nodeId ? 2 : 1,
				);

			// Highlight node circle
			d3.select(this).select("circle").attr("r", 6);

			options.onNodeHover(nodeId);
		})
		.on("mouseleave", function (_event, d) {
			edgePaths.attr("stroke-opacity", 0.4).attr("stroke-width", 1);
			d3.select(this).select("circle").attr("r", 4);
			if (d.id) options.onNodeHover(null);
		})
		.on("click", (_event, d) => {
			options.onNodeClick(d.id);
		});

	// Draw highlight rings for search-matched nodes
	if (options.highlightedNodeIds.size > 0) {
		const highlightedLeaves = leaves.filter((d) =>
			options.highlightedNodeIds.has(d.id),
		);
		nodeGroup
			.selectAll<SVGCircleElement, LayoutLeaf>("circle.highlight-ring")
			.data(highlightedLeaves, (d) => d.id)
			.join("circle")
			.attr("class", "highlight-ring")
			.attr("transform", (d) => {
				return `translate(${d.x},${d.y})`;
			})
			.attr("r", 7)
			.attr("fill", "none")
			.attr("stroke", "#facc15")
			.attr("stroke-width", 2)
			.attr("opacity", 0.8)
			.attr("pointer-events", "none");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function filterEdges(
	edges: HierarchyEdge[],
	options: HebOptions,
	leafById: Map<string, LayoutLeaf>,
): HierarchyEdge[] {
	return edges.filter((e) => {
		if (!options.edgeTypeFilter.includes(e.type)) return false;
		if (!leafById.has(e.source) || !leafById.has(e.target)) return false;
		if (options.moduleFilter !== null) {
			const src = leafById.get(e.source);
			const tgt = leafById.get(e.target);
			if (
				src?.module !== options.moduleFilter &&
				tgt?.module !== options.moduleFilter
			) {
				return false;
			}
		}
		return true;
	});
}

function buildLayoutLeaves(
	root: d3.HierarchyNode<HierarchyNode>,
	shapeMode: ShapeMode,
	radius: number,
): LayoutLeaf[] {
	if (shapeMode === "pack") {
		const packRoot = d3
			.hierarchy<HierarchyNode>(root.data, (d) => d.children)
			.sum(() => 1)
			.sort((a, b) => d3.ascending(a.data.name, b.data.name));

		d3
			.pack<HierarchyNode>()
			.size([radius * 2, radius * 2])
			.padding(3)(packRoot);

		return packRoot
			.leaves()
			.map((leaf) => ({
				id: leaf.data.id,
				name: leaf.data.name,
				module: leaf.data.module,
				node: leaf.data,
				x: leaf.x - radius,
				y: leaf.y - radius,
				labelX: 8,
				labelRotate: 0,
				textAnchor: "start",
				flipText: false,
			}))
			.filter((leaf) => Number.isFinite(leaf.x) && Number.isFinite(leaf.y));
	}

	if (shapeMode === "arc") {
		const leaves = root.leaves();
		const n = leaves.length;
		if (n === 0) return [];

		const startX = -radius;
		const spacing = n > 1 ? (radius * 2) / (n - 1) : 0;
		const y = radius * 0.78;

		return leaves
			.map((leaf, index) => ({
				id: leaf.data.id,
				name: leaf.data.name,
				module: leaf.data.module,
				node: leaf.data,
				x: startX + spacing * index,
				y,
				labelX: 0,
				labelRotate: -55,
				textAnchor: "end",
				flipText: false,
			}))
			.filter((leaf) => Number.isFinite(leaf.x) && Number.isFinite(leaf.y));
	}

	const radialRoot = d3
		.hierarchy<HierarchyNode>(root.data, (d) => d.children)
		.sort((a, b) => d3.ascending(a.data.name, b.data.name));

	if (shapeMode === "tree") {
		d3.tree<HierarchyNode>().size([2 * Math.PI, radius])(radialRoot);
	} else {
		d3.cluster<HierarchyNode>().size([2 * Math.PI, radius])(radialRoot);
	}

	return radialRoot
		.leaves()
		.map((leaf) => {
			const [x, y] = radialPoint(leaf.x, leaf.y);
			const isRightHalf = leaf.x < Math.PI;

			return {
				id: leaf.data.id,
				name: leaf.data.name,
				module: leaf.data.module,
				node: leaf.data,
				x,
				y,
				labelX: isRightHalf ? 8 : -8,
				labelRotate: (leaf.x * 180) / Math.PI - 90,
				textAnchor: isRightHalf ? "start" : "end",
				flipText: !isRightHalf,
				pointNode: leaf,
			};
		})
		.filter((leaf) => Number.isFinite(leaf.x) && Number.isFinite(leaf.y));
}

function buildFocusTransform(
	leaves: LayoutLeaf[],
	options: HebOptions,
): string {
	const scale = Math.max(0.5, Math.min(2.5, options.zoomScale));

	let focusLeaves = leaves;
	if (options.focusMode === "module" && options.moduleFilter) {
		const byModule = leaves.filter(
			(leaf) => leaf.module === options.moduleFilter,
		);
		if (byModule.length > 0) {
			focusLeaves = byModule;
		}
	}

	if (
		options.focusMode === "highlights" &&
		options.highlightedNodeIds.size > 0
	) {
		const highlighted = leaves.filter((leaf) =>
			options.highlightedNodeIds.has(leaf.id),
		);
		if (highlighted.length > 0) {
			focusLeaves = highlighted;
		}
	}

	if (focusLeaves.length === 0) {
		return `scale(${scale})`;
	}

	const centroid = focusLeaves.reduce(
		(acc, leaf) => ({ x: acc.x + leaf.x, y: acc.y + leaf.y }),
		{ x: 0, y: 0 },
	);

	const cx = centroid.x / focusLeaves.length;
	const cy = centroid.y / focusLeaves.length;

	if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
		return `scale(${scale})`;
	}

	// SVG transform lists are applied right-to-left. Put scale first so
	// translation is applied in graph-space before zoom scaling.
	return `scale(${scale}) translate(${-cx},${-cy})`;
}

function nodeColor(node: HierarchyNode, options: HebOptions): string {
	if (options.colorMode === "churn" && node.churnRate !== undefined) {
		// Normalise churn rate: 0–10 commits/month → 0–1
		return churnColor(Math.min(node.churnRate / 10, 1));
	}
	if (options.colorMode === "doa" && node.doaScore !== undefined) {
		return doaColor(node.doaScore);
	}
	return moduleColor(node.module);
}

function radialPoint(angle: number, radius: number): [number, number] {
	return [
		radius * Math.cos(angle - Math.PI / 2),
		radius * Math.sin(angle - Math.PI / 2),
	];
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}
