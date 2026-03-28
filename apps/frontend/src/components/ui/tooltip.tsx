import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TooltipProps {
	children: ReactNode;
	content: ReactNode;
	side?: "top" | "bottom" | "left" | "right";
	delayDuration?: number;
}

/** Simple Radix Tooltip wrapper. Wrap your app in <TooltipProvider> once at root. */
export function Tooltip({
	children,
	content,
	side = "top",
	delayDuration = 300,
}: TooltipProps) {
	return (
		<RadixTooltip.Root delayDuration={delayDuration}>
			<RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
			<RadixTooltip.Portal>
				<RadixTooltip.Content
					side={side}
					sideOffset={6}
					className={cn(
						"z-50 max-w-xs rounded-md border border-[--color-border] px-2.5 py-1.5",
						"text-xs text-[--color-text] shadow-md",
						"animate-in fade-in-0 zoom-in-95",
					)}
					style={{ background: "var(--color-surface-2)" }}
				>
					{content}
					<RadixTooltip.Arrow className="fill-[--color-border]" />
				</RadixTooltip.Content>
			</RadixTooltip.Portal>
		</RadixTooltip.Root>
	);
}

export { RadixTooltip as TooltipPrimitive };
export const TooltipProvider = RadixTooltip.Provider;
