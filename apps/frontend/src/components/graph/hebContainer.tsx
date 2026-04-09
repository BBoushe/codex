/**
 * @fileoverview React wrapper for the HEB D3 visualization.
 *
 * Owns the lifecycle: init on mount / data available, update on filter changes,
 * destroy on unmount. D3 owns the SVG DOM — React only provides the container div.
 */

import { useRef, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useGraphStore } from "@/stores/graphStore";
import { useEntityStore } from "@/stores/entityStore";
import { useUiStore } from "@/stores/uiStore";
import {
	initHeb,
	updateHeb,
	destroyHeb,
	type HebInstance,
} from "./hebVisualization";
import { HebControls } from "./hebControls";
import { HebTooltip } from "./hebTooltip";
import { cn } from "@/lib/utils";

export function HebContainer() {
	const containerRef = useRef<HTMLDivElement>(null);
	const instanceRef = useRef<HebInstance | null>(null);

	const {
		hierarchyData,
		isLoading,
		error,
		edgeTypeFilter,
		moduleFilter,
		colorMode,
		shapeMode,
		zoomScale,
		focusMode,
		highlightedNodeIds,
		setHoveredNode,
		fetchHierarchy,
	} = useGraphStore();

	const selectEntity = useEntityStore((s) => s.selectEntity);
	const setSidePanelMode = useUiStore((s) => s.setSidePanelMode);

	function handleNodeClick(nodeId: string) {
		selectEntity(nodeId);
		setSidePanelMode("entity");
	}

	// Init / destroy when data arrives
	useEffect(() => {
		if (!containerRef.current || !hierarchyData) return;

		// Destroy previous instance if it exists
		if (instanceRef.current) {
			destroyHeb(instanceRef.current);
			instanceRef.current = null;
		}

		instanceRef.current = initHeb(containerRef.current, hierarchyData, {
			edgeTypeFilter,
			colorMode,
			shapeMode,
			zoomScale,
			focusMode,
			moduleFilter,
			highlightedNodeIds,
			onNodeHover: setHoveredNode,
			onNodeClick: handleNodeClick,
		});

		return () => {
			if (instanceRef.current) {
				destroyHeb(instanceRef.current);
				instanceRef.current = null;
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hierarchyData]);

	// Update filters / color mode without re-initialising
	useEffect(() => {
		if (!instanceRef.current || !hierarchyData) return;

		updateHeb(instanceRef.current, hierarchyData, {
			edgeTypeFilter,
			colorMode,
			shapeMode,
			zoomScale,
			focusMode,
			moduleFilter,
			highlightedNodeIds,
			onNodeHover: setHoveredNode,
			onNodeClick: handleNodeClick,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		edgeTypeFilter,
		colorMode,
		shapeMode,
		zoomScale,
		focusMode,
		moduleFilter,
		highlightedNodeIds,
	]);

	// Fetch if not loaded
	useEffect(() => {
		if (!hierarchyData && !isLoading) {
			fetchHierarchy();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full gap-2 text-sm text-[var(--color-text-muted)]">
				<Loader2 size={16} className="animate-spin" />
				<span>Loading graph…</span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex items-center justify-center h-full">
				<p className="text-sm text-red-400">{error}</p>
			</div>
		);
	}

	if (!hierarchyData) return null;

	return (
		<div className={cn("relative w-full h-full")}>
			{/* D3 mounts the SVG here */}
			<div ref={containerRef} className="w-full h-full" />

			{/* Filter controls overlay */}
			<HebControls />

			{/* Hover tooltip */}
			<HebTooltip />
		</div>
	);
}
