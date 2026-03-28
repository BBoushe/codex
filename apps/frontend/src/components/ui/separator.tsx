import { cn } from "@/lib/utils";

interface SeparatorProps {
	orientation?: "horizontal" | "vertical";
	className?: string;
}

export function Separator({ orientation = "horizontal", className }: SeparatorProps) {
	if (orientation === "vertical") {
		return (
			<div
				role="separator"
				aria-orientation="vertical"
				className={cn("w-px self-stretch bg-[--color-border]", className)}
			/>
		);
	}
	return (
		<div
			role="separator"
			className={cn("h-px w-full bg-[--color-border]", className)}
		/>
	);
}
