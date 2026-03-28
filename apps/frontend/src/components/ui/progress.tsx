import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
	/** Value 0–1 */
	value: number;
	/** Color variant */
	variant?: "accent" | "doa" | "churn";
}

function fillColor(value: number, variant: ProgressProps["variant"]) {
	if (variant === "accent") return "bg-[--color-accent]";
	if (variant === "churn") {
		// green → yellow → red
		if (value < 0.33) return "bg-emerald-500";
		if (value < 0.66) return "bg-amber-400";
		return "bg-red-500";
	}
	// doa: light → deep blue
	if (value < 0.4) return "bg-blue-400/60";
	if (value < 0.7) return "bg-blue-500";
	return "bg-blue-400";
}

export function Progress({ value, variant = "accent", className, ...props }: ProgressProps) {
	const pct = Math.min(100, Math.max(0, Math.round(value * 100)));

	return (
		<div
			role="progressbar"
			aria-valuenow={pct}
			aria-valuemin={0}
			aria-valuemax={100}
			className={cn(
				"h-1 rounded-full bg-[--color-border] overflow-hidden",
				className,
			)}
			{...props}
		>
			<div
				className={cn(
					"h-full rounded-full transition-[width] duration-300",
					fillColor(value, variant),
				)}
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}
