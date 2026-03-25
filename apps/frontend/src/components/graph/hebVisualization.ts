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
import type { HierarchyResponse, HierarchyNode, HierarchyEdge, HebOptions } from "@/types/graph";
import { moduleColor, EDGE_TYPE_COLORS, churnColor, doaColor } from "@/lib/colors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LeafNode extends d3.HierarchyPointNode<HierarchyNode> {
	x: number;
	y: number;
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

	// Clear previous render
	d3.select(svgEl).selectAll("*").remove();

	const svg = d3
		.select(svgEl)
		.attr("viewBox", `${-width / 2} ${-height / 2} ${width} ${height}`);

	// ── Build D3 hierarchy ──────────────────────────────────────────────────

	const root = d3
		.hierarchy<HierarchyNode>(data.tree, (d) => d.children)
		.sort((a, b) => d3.ascending(a.data.name, b.data.name));

	const cluster = d3.cluster<HierarchyNode>().size([2 * Math.PI, radius]);
	cluster(root);

	const leaves = root.leaves() as LeafNode[];

	// Build a map from nodeId → leaf node for edge drawing
	const leafById = new Map<string, LeafNode>();
	for (const leaf of leaves) {
		leafById.set(leaf.data.id, leaf);
	}

	// ── Filter edges ────────────────────────────────────────────────────────

	const visibleEdges = filterEdges(data.edges, options, leafById);

	// ── Draw edges ──────────────────────────────────────────────────────────

	const lineGenerator = d3
		.lineRadial<d3.HierarchyPointNode<HierarchyNode>>()
		.curve(d3.curveBundle.beta(0.85))
		.angle((d) => d.x)
		.radius((d) => d.y);

	const edgeGroup = svg.append("g").attr("class", "edges");

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
			// Build the path through ancestor nodes for bundling
			const pathNodes = source
				.path(target)
				.filter((n): n is d3.HierarchyPointNode<HierarchyNode> => "x" in n && "y" in n);
			return lineGenerator(pathNodes) ?? "";
		})
		.attr("stroke", (d) => EDGE_TYPE_COLORS[d.type] ?? EDGE_TYPE_COLORS["default"]!);

	// ── Draw nodes ──────────────────────────────────────────────────────────

	const nodeGroup = svg.append("g").attr("class", "nodes");

	nodeGroup
		.selectAll("g")
		.data(leaves)
		.join("g")
		.attr("transform", (d) => {
			const angle = (d.x * 180) / Math.PI - 90;
			const translate = `translate(${radialPoint(d.x, d.y).join(",")})`;
			return `${translate} rotate(${angle})`;
		})
		.each(function (d) {
			const g = d3.select(this);
			const isRightHalf = d.x < Math.PI;
			const color = nodeColor(d.data, options);

			// Circle
			g.append("circle")
				.attr("r", 4)
				.attr("fill", color)
				.attr("stroke", "#0f1117")
				.attr("stroke-width", 1.5)
				.attr("cursor", "pointer");

			// Label
			g.append("text")
				.attr("x", isRightHalf ? 8 : -8)
				.attr("text-anchor", isRightHalf ? "start" : "end")
				.attr("dominant-baseline", "central")
				.attr("font-size", "9px")
				.attr("fill", "#8892a4")
				.attr("cursor", "pointer")
				.attr("transform", isRightHalf ? "" : "rotate(180)")
				.text(truncate(d.data.name, 20));
		})
		.on("mouseenter", function (event, d) {
			// Highlight connected edges
			const nodeId = d.data.id;
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
			if (d.data.id) options.onNodeHover(null);
		})
		.on("click", (_event, d) => {
			options.onNodeClick(d.data.id);
		});
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function filterEdges(
	edges: HierarchyEdge[],
	options: HebOptions,
	leafById: Map<string, LeafNode>,
): HierarchyEdge[] {
	return edges.filter((e) => {
		if (!options.edgeTypeFilter.includes(e.type)) return false;
		if (!leafById.has(e.source) || !leafById.has(e.target)) return false;
		if (options.moduleFilter !== null) {
			const src = leafById.get(e.source);
			const tgt = leafById.get(e.target);
			if (src?.data.module !== options.moduleFilter && tgt?.data.module !== options.moduleFilter) {
				return false;
			}
		}
		return true;
	});
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
