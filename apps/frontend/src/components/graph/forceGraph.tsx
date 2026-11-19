/**
 * @fileoverview Force-directed subgraph explorer (Week 13).
 *
 * Renders a neighborhood subgraph around a center node using react-force-graph-2d.
 * Nodes are colored by type, sized by the active SizingMetric, and can be
 * expanded or recentered via a right-click context menu.
 */

import { useRef, useState, useMemo, useCallback, useLayoutEffect } from "react"; // useLayoutEffect: cluster force must run before paint
import ForceGraph2D from "react-force-graph-2d";
import type {
	ForceGraphMethods,
	NodeObject,
	LinkObject,
} from "react-force-graph-2d";
import { useForceStore } from "@/stores/forceStore";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";
import { NODE_TYPE_COLORS, EDGE_TYPE_COLORS } from "@/lib/colors";
import { ForceControls } from "./forceControls";
import { NodeContextMenu } from "./nodeContextMenu";
import type { ForceGraphNode } from "@/types/graph";

// ─────────────────────────────────────────────────────────────────────────────
// Convex hull helpers
// ─────────────────────────────────────────────────────────────────────────────

type Point = { x: number; y: number };

function crossProduct(O: Point, A: Point, B: Point): number {
	return (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
}

/** Graham scan — returns points of the convex hull in CCW order. */
function computeHull(pts: Point[]): Point[] {
	if (pts.length < 3) return [...pts];
	const sorted = [...pts].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
	const lower: Point[] = [];
	for (const p of sorted) {
		while (
			lower.length >= 2 &&
			crossProduct(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0
		)
			lower.pop();
		lower.push(p);
	}
	const upper: Point[] = [];
	for (let i = sorted.length - 1; i >= 0; i--) {
		const p = sorted[i]!;
		while (
			upper.length >= 2 &&
			crossProduct(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0
		)
			upper.pop();
		upper.push(p);
	}
	upper.pop();
	lower.pop();
	return lower.concat(upper);
}

/** Expands each hull point outward from the centroid by `pad` pixels. */
function expandHull(hull: Point[], pad: number): Point[] {
	const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
	const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
	return hull.map((p) => {
		const dx = p.x - cx || 0.001;
		const dy = p.y - cy || 0.001;
		const dist = Math.sqrt(dx * dx + dy * dy);
		return { x: p.x + (dx / dist) * pad, y: p.y + (dy / dist) * pad };
	});
}

const GROUP_HULL_COLORS = [
	"99,102,241", // indigo
	"16,185,129", // emerald
	"245,158,11", // amber
	"239,68,68", // red
	"59,130,246", // blue
	"168,85,247", // purple
	"236,72,153", // pink
	"20,184,166", // teal
];

// ─────────────────────────────────────────────────────────────────────────────
// Node sizing
// ─────────────────────────────────────────────────────────────────────────────

function nodeRadius(node: ForceGraphNode, metric: string): number {
	const MIN = 5;
	const MAX = 20;
	const range = MAX - MIN;
	switch (metric) {
		case "loc":
			return MIN + Math.min(node.linesOfCode / 200, 1) * range;
		case "doa":
			return MIN + Math.min(node.doaScore, 1) * range;
		case "churn":
			return MIN + Math.min(node.churnRate / 10, 1) * range;
		default:
			return MIN + range * 0.3;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Context menu state
// ─────────────────────────────────────────────────────────────────────────────

interface ContextMenuState {
	x: number;
	y: number;
	nodeId: string;
	nodeName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ForceGraph() {
	const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
	const containerRef = useRef<HTMLDivElement>(null);
	const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [showHint, setShowHint] = useState(true);

	const {
		subgraphData,
		showDevelopers,
		showFiles,
		groupByDirectory,
		groupByLabel,
		sizingMetric,
		expandedNodeIds,
		highlightedNodeIds,
		expandNode,
		recenterOn,
	} = useForceStore();

	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);
	const themeMode = useUiStore((s) => s.themeMode);
	const leftPanelOpen = useUiStore((s) => s.leftPanelOpen);

	// Track container dimensions.
	// Re-runs when leftPanelOpen changes (grid column transition) OR when
	// subgraphData first arrives (component may have mounted with stale 1×1 dims).
	const hasData = !!subgraphData;
	useLayoutEffect(() => {
		const host = containerRef.current;
		if (!host) return;

		const measure = () => {
			const parent = host.parentElement;
			const rect = (parent ?? host).getBoundingClientRect();
			const width = Math.max(1, Math.round(rect.width));
			const height = Math.max(1, Math.round(rect.height));
			setDimensions({ width, height });
		};

		// Measure immediately, after the next paint, and after grid transitions.
		measure();
		const raf = requestAnimationFrame(measure);
		const transitionTimer = window.setTimeout(measure, 320);
		// Extra remeasure at 400ms covers the 300ms grid CSS transition + margin.
		const lateTimer = window.setTimeout(measure, 400);

		const ro = new ResizeObserver((entries) => {
			if (entries.length > 0) measure();
		});
		ro.observe(host);
		if (host.parentElement) ro.observe(host.parentElement);

		window.addEventListener("resize", measure);
		return () => {
			cancelAnimationFrame(raf);
			window.clearTimeout(transitionTimer);
			window.clearTimeout(lateTimer);
			window.removeEventListener("resize", measure);
			ro.disconnect();
		};
	}, [leftPanelOpen, hasData]);

	const canvasBackground = (() => {
		const container = containerRef.current;
		if (container) {
			const cssVar = getComputedStyle(container)
				.getPropertyValue("--color-background")
				.trim();
			if (cssVar) return cssVar;
		}

		// Fallback if CSS vars are unavailable at initial render.
		return themeMode === "light" ? "#fafafa" : "#0f1117";
	})();

	// Filter and shape data for the graph
	const graphData = useMemo(() => {
		if (!subgraphData) return { nodes: [], links: [] };

		const nodes = subgraphData.nodes.filter(
			(n) =>
				(showDevelopers || !n.isDeveloper) && (showFiles || n.label !== "File"),
		) as ForceGraphNode[];

		const visibleIds = new Set(nodes.map((n) => n.nodeId));
		const links = subgraphData.edges.filter(
			(e) => visibleIds.has(e.source) && visibleIds.has(e.target),
		);

		return { nodes, links };
	}, [subgraphData, showDevelopers, showFiles]);

	// ── Cluster targets (one fixed position per group — directory or label) ──
	const activeGrouping = groupByDirectory
		? "directory"
		: groupByLabel
			? "label"
			: null;

	/** Returns the group key for a node based on the active grouping mode. */
	function nodeGroupKey(n: ForceGraphNode): string {
		if (activeGrouping === "directory") return n.directory ?? "";
		if (activeGrouping === "label") return n.label ?? "";
		return "";
	}

	const clusterTargets = useMemo<Map<string, Point>>(() => {
		if (!activeGrouping) return new Map();
		const keys = [
			...new Set(
				(graphData.nodes as ForceGraphNode[])
					.map((n) => nodeGroupKey(n))
					.filter(Boolean),
			),
		];
		const R = Math.max(
			150,
			Math.min(320, 45 * Math.sqrt(graphData.nodes.length)),
		);
		const targets = new Map<string, Point>();
		keys.forEach((key, i) => {
			const angle = (2 * Math.PI * i) / keys.length - Math.PI / 2;
			targets.set(key, { x: Math.cos(angle) * R, y: Math.sin(angle) * R });
		});
		return targets;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeGrouping, graphData.nodes]);

	// ── Add / remove D3 cluster force when grouping or data changes ──
	useLayoutEffect(() => {
		const fg = fgRef.current;
		if (!fg) return;

		if (!activeGrouping || clusterTargets.size === 0) {
			fg.d3Force("cluster", null);
			return;
		}

		const nodeGroup = new Map<string, string>();
		for (const n of graphData.nodes as ForceGraphNode[]) {
			nodeGroup.set(n.nodeId, nodeGroupKey(n));
		}

		type SimNode = {
			nodeId?: string;
			x?: number;
			y?: number;
			vx?: number;
			vy?: number;
		};
		let simNodes: SimNode[] = [];

		function clusterForce(alpha: number) {
			for (const n of simNodes) {
				if (!n.nodeId) continue;
				const key = nodeGroup.get(n.nodeId) ?? "";
				const target = clusterTargets.get(key);
				if (!target) continue;
				n.vx = (n.vx ?? 0) + (target.x - (n.x ?? 0)) * 0.06 * alpha;
				n.vy = (n.vy ?? 0) + (target.y - (n.y ?? 0)) * 0.06 * alpha;
			}
		}
		(
			clusterForce as typeof clusterForce & {
				initialize: (ns: SimNode[]) => void;
			}
		).initialize = (ns) => {
			simNodes = ns;
		};

		fg.d3Force("cluster", clusterForce);
		fg.d3ReheatSimulation();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeGrouping, clusterTargets, graphData.nodes]);

	// ── Convex hull overlay (drawn before nodes so hulls sit behind) ─────────
	const renderHulls = useCallback(
		(ctx: CanvasRenderingContext2D) => {
			if (!activeGrouping || graphData.nodes.length === 0) return;

			// Collect current positions per group key
			const groups = new Map<string, Point[]>();
			for (const node of graphData.nodes as ForceGraphNode[]) {
				if (node.x === undefined || node.y === undefined) continue;
				const key = nodeGroupKey(node);
				if (!key) continue;
				const pts = groups.get(key) ?? [];
				pts.push({ x: node.x, y: node.y });
				groups.set(key, pts);
			}

			const dirs = [...groups.keys()];
			dirs.forEach((dir, idx) => {
				const pts = groups.get(dir)!;
				const rgb = GROUP_HULL_COLORS[idx % GROUP_HULL_COLORS.length]!;

				ctx.save();
				if (pts.length === 1) {
					ctx.beginPath();
					ctx.arc(pts[0]!.x, pts[0]!.y, 30, 0, 2 * Math.PI);
					ctx.fillStyle = `rgba(${rgb},0.08)`;
					ctx.fill();
					ctx.strokeStyle = `rgba(${rgb},0.28)`;
					ctx.lineWidth = 1.2;
					ctx.stroke();
				} else {
					const hull =
						pts.length === 2
							? [
									{ x: pts[0]!.x - 20, y: pts[0]!.y },
									{ x: pts[1]!.x - 20, y: pts[1]!.y },
									{ x: pts[1]!.x + 20, y: pts[1]!.y },
									{ x: pts[0]!.x + 20, y: pts[0]!.y },
								]
							: computeHull(pts);
					if (hull.length < 2) {
						ctx.restore();
						return;
					}
					const padded = expandHull(hull, 26);
					ctx.beginPath();
					ctx.moveTo(padded[0]!.x, padded[0]!.y);
					for (let i = 1; i < padded.length; i++)
						ctx.lineTo(padded[i]!.x, padded[i]!.y);
					ctx.closePath();
					ctx.fillStyle = `rgba(${rgb},0.07)`;
					ctx.fill();
					ctx.strokeStyle = `rgba(${rgb},0.30)`;
					ctx.lineWidth = 1.5;
					ctx.setLineDash([4, 3]);
					ctx.stroke();
					ctx.setLineDash([]);
				}
				ctx.restore();
			});
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[activeGrouping, graphData.nodes],
	);

	// Custom node renderer
	const nodeCanvasObject = useCallback(
		(node: NodeObject, ctx: CanvasRenderingContext2D, globalScale: number) => {
			const n = node as ForceGraphNode;
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			const r = nodeRadius(n, sizingMetric);
			const colorKey = n.label.toLowerCase();
			const color = NODE_TYPE_COLORS[colorKey] ?? NODE_TYPE_COLORS["default"]!;

			// Highlight ring for search results
			if (highlightedNodeIds.has(n.nodeId)) {
				ctx.beginPath();
				ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
				ctx.fillStyle = "#facc15";
				ctx.globalAlpha = 0.35;
				ctx.fill();
				ctx.globalAlpha = 1;
			}

			// Center node ring
			if (subgraphData?.centerNodeId === n.nodeId) {
				ctx.beginPath();
				ctx.arc(x, y, r + 2, 0, 2 * Math.PI);
				ctx.strokeStyle = "#6366f1";
				ctx.lineWidth = 2;
				ctx.stroke();
			}

			// Node circle
			ctx.beginPath();
			ctx.arc(x, y, r, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();

			// Label (always shown for center node, otherwise only when zoomed in)
			const showLabel =
				globalScale > 1.2 || subgraphData?.centerNodeId === n.nodeId;
			if (showLabel) {
				const label = n.name.length > 20 ? `${n.name.slice(0, 20)}…` : n.name;
				const fontSize = Math.max(11 / globalScale, 5);
				ctx.font = `${fontSize}px sans-serif`;
				ctx.fillStyle = "#c9d1d9";
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				ctx.fillText(label, x, y + r + 3);
			}
		},
		[sizingMetric, highlightedNodeIds, subgraphData?.centerNodeId],
	);

	// Edge label renderer
	const linkCanvasObject = useCallback(
		(link: LinkObject, ctx: CanvasRenderingContext2D, globalScale: number) => {
			if (globalScale < 1.2) return;
			const l = link as {
				source: NodeObject;
				target: NodeObject;
				type: string;
			};
			const sx = l.source.x ?? 0;
			const sy = l.source.y ?? 0;
			const tx = l.target.x ?? 0;
			const ty = l.target.y ?? 0;
			const mx = (sx + tx) / 2;
			const my = (sy + ty) / 2;

			const edgeType = l.type ?? "";
			const fontSize = Math.max(8 / globalScale, 4);
			ctx.font = `${fontSize}px sans-serif`;
			ctx.fillStyle = "rgba(136,146,164,0.8)";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(edgeType, mx, my);
		},
		[],
	);

	const handleNodeClick = useCallback(
		(node: NodeObject) => {
			const n = node as ForceGraphNode;
			selectEntity(n.nodeId);
			setSidePanelMode("entity");
			setContextMenu(null);
		},
		[selectEntity, setSidePanelMode],
	);

	const handleNodeRightClick = useCallback(
		(node: NodeObject, event: MouseEvent) => {
			event.preventDefault();
			const n = node as ForceGraphNode;
			const rect = containerRef.current?.getBoundingClientRect();
			setContextMenu({
				x: event.clientX - (rect?.left ?? 0),
				y: event.clientY - (rect?.top ?? 0),
				nodeId: n.nodeId,
				nodeName: n.name,
			});
		},
		[],
	);

	const handleBackgroundClick = useCallback(() => {
		setContextMenu(null);
	}, []);

	// After simulation settles, center on the center node
	const handleEngineStop = useCallback(() => {
		const fg = fgRef.current;
		if (!fg || !subgraphData) return;
		const centerNode = graphData.nodes.find(
			(n) => (n as ForceGraphNode).nodeId === subgraphData.centerNodeId,
		);
		if (
			centerNode &&
			centerNode.x !== undefined &&
			centerNode.y !== undefined
		) {
			fg.centerAt(centerNode.x, centerNode.y, 600);
			fg.zoom(2, 600);
		} else {
			fg.zoomToFit(400, 40);
		}
	}, [subgraphData, graphData.nodes]);

	if (!subgraphData) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2 text-center px-8">
				<p className="text-sm text-[var(--color-text-muted)]">
					Select an entity and click{" "}
					<strong className="text-[var(--color-text)]">Explore</strong> to
					visualize its neighborhood.
				</p>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="absolute inset-0 min-w-0 min-h-0 overflow-hidden"
		>
			<div className="absolute inset-0 z-0">
				<ForceGraph2D
					ref={fgRef as React.MutableRefObject<ForceGraphMethods | undefined>}
					width={dimensions.width}
					height={dimensions.height}
					graphData={graphData}
					nodeId="nodeId"
					linkSource="source"
					linkTarget="target"
					backgroundColor={canvasBackground}
					nodeCanvasObject={nodeCanvasObject}
					nodeCanvasObjectMode={() => "replace"}
					nodePointerAreaPaint={(node, color, ctx) => {
						const n = node as ForceGraphNode;
						const r = nodeRadius(n, sizingMetric) + 4;
						ctx.beginPath();
						ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
						ctx.fillStyle = color;
						ctx.fill();
					}}
					linkColor={(link) =>
						EDGE_TYPE_COLORS[(link as { type: string }).type] ??
						EDGE_TYPE_COLORS["default"]!
					}
					linkDirectionalArrowLength={5}
					linkDirectionalArrowRelPos={1}
					linkWidth={1.5}
					linkCanvasObject={linkCanvasObject}
					linkCanvasObjectMode={() => "after"}
					onNodeClick={handleNodeClick}
					onNodeRightClick={handleNodeRightClick}
					onBackgroundClick={handleBackgroundClick}
					onBackgroundRightClick={handleBackgroundClick}
					onRenderFramePre={renderHulls}
					cooldownTicks={80}
					onEngineStop={handleEngineStop}
				/>
			</div>

			<ForceControls
				fgRef={fgRef as React.MutableRefObject<ForceGraphMethods | undefined>}
				onSizingChange={() => fgRef.current?.d3ReheatSimulation()}
			/>

			{/* Hint overlay */}
			{showHint ? (
				<div className="absolute z-20 bottom-3 left-3 max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/90 backdrop-blur-sm px-4 py-3 text-sm text-[var(--color-text-muted)]">
					<div className="flex items-start justify-between gap-3">
						<span>
							Showing{" "}
							<strong className="text-[var(--color-text)]">
								{graphData.nodes.length}
							</strong>{" "}
							nodes around{" "}
							<strong className="text-[var(--color-text)]">
								{graphData.nodes.find(
									(n) =>
										(n as ForceGraphNode).nodeId === subgraphData.centerNodeId,
								)?.name ?? "center"}
							</strong>
							. Left-click: details · Right-click: expand / recenter
						</span>
						<button
							onClick={() => setShowHint(false)}
							className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors leading-none"
						>
							✕
						</button>
					</div>
				</div>
			) : (
				<button
					onClick={() => setShowHint(true)}
					className="absolute z-20 bottom-3 left-3 w-7 h-7 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/90 backdrop-blur-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] flex items-center justify-center text-xs font-medium transition-colors"
					title="Show hints"
				>
					?
				</button>
			)}

			{contextMenu && (
				<NodeContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					nodeId={contextMenu.nodeId}
					nodeName={contextMenu.nodeName}
					isExpanded={expandedNodeIds.has(contextMenu.nodeId)}
					onExpand={() => {
						expandNode(contextMenu.nodeId);
						setShowHint(false);
					}}
					onRecenter={() => {
						recenterOn(contextMenu.nodeId);
						setShowHint(true);
					}}
					onViewDetails={() => {
						selectEntity(contextMenu.nodeId);
						setSidePanelMode("entity");
					}}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</div>
	);
}
