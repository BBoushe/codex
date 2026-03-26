/**
 * @fileoverview Force-directed subgraph explorer (Week 13).
 *
 * Renders a neighborhood subgraph around a center node using react-force-graph-2d.
 * Nodes are colored by type, sized by the active SizingMetric, and can be
 * expanded or recentered via a right-click context menu.
 */

import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods, NodeObject } from "react-force-graph-2d";
import { useForceStore } from "@/stores/forceStore";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";
import { NODE_TYPE_COLORS, EDGE_TYPE_COLORS } from "@/lib/colors";
import { ForceControls } from "./forceControls";
import { NodeContextMenu } from "./nodeContextMenu";
import type { ForceGraphNode } from "@/types/graph";

// ─────────────────────────────────────────────────────────────────────────────
// Node sizing
// ─────────────────────────────────────────────────────────────────────────────

function nodeRadius(node: ForceGraphNode, metric: string): number {
	const MIN = 3;
	const MAX = 14;
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
	const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

	const {
		subgraphData,
		showDevelopers,
		sizingMetric,
		expandedNodeIds,
		highlightedNodeIds,
		expandNode,
		recenterOn,
	} = useForceStore();

	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);

	// Track container dimensions
	useEffect(() => {
		if (!containerRef.current) return;
		const ro = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) {
				setDimensions({
					width: entry.contentRect.width,
					height: entry.contentRect.height,
				});
			}
		});
		ro.observe(containerRef.current);
		return () => ro.disconnect();
	}, []);

	// Filter and shape data for the graph
	const graphData = useMemo(() => {
		if (!subgraphData) return { nodes: [], links: [] };

		const nodes = subgraphData.nodes.filter(
			(n) => showDevelopers || !n.isDeveloper,
		) as ForceGraphNode[];

		const visibleIds = new Set(nodes.map((n) => n.nodeId));
		const links = subgraphData.edges.filter(
			(e) => visibleIds.has(e.source) && visibleIds.has(e.target),
		);

		return { nodes, links };
	}, [subgraphData, showDevelopers]);

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
				ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
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
				ctx.lineWidth = 1.5;
				ctx.stroke();
			}

			// Node circle
			ctx.beginPath();
			ctx.arc(x, y, r, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();

			// Label (only when zoomed in enough)
			if (globalScale > 1.5) {
				const label = n.name.length > 18 ? `${n.name.slice(0, 18)}…` : n.name;
				ctx.font = `${Math.max(10 / globalScale, 4)}px sans-serif`;
				ctx.fillStyle = "#c9d1d9";
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				ctx.fillText(label, x, y + r + 2);
			}
		},
		[sizingMetric, highlightedNodeIds, subgraphData?.centerNodeId],
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

	if (!subgraphData) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2 text-center px-8">
				<p className="text-sm text-[--color-text-muted]">
					Select an entity and click <strong className="text-[--color-text]">Explore</strong> to visualize its neighborhood.
				</p>
			</div>
		);
	}

	return (
		<div ref={containerRef} className="relative w-full h-full">
			<ForceGraph2D
				ref={fgRef as React.MutableRefObject<ForceGraphMethods | undefined>}
				width={dimensions.width}
				height={dimensions.height}
				graphData={graphData}
				nodeId="nodeId"
				linkSource="source"
				linkTarget="target"
				backgroundColor="#0f1117"
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
				linkColor={(link) => EDGE_TYPE_COLORS[(link as { type: string }).type] ?? EDGE_TYPE_COLORS["default"]!}
				linkDirectionalArrowLength={4}
				linkDirectionalArrowRelPos={1}
				linkWidth={1}
				onNodeClick={handleNodeClick}
				onNodeRightClick={handleNodeRightClick}
				onBackgroundClick={handleBackgroundClick}
				onBackgroundRightClick={handleBackgroundClick}
				cooldownTicks={80}
				onEngineStop={() => fgRef.current?.zoomToFit(400, 40)}
			/>

			<ForceControls fgRef={fgRef as React.MutableRefObject<ForceGraphMethods | undefined>} />

			{contextMenu && (
				<NodeContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					nodeId={contextMenu.nodeId}
					nodeName={contextMenu.nodeName}
					isExpanded={expandedNodeIds.has(contextMenu.nodeId)}
					onExpand={() => expandNode(contextMenu.nodeId)}
					onRecenter={() => recenterOn(contextMenu.nodeId)}
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
