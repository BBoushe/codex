import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
	{
		variants: {
			variant: {
				default: "bg-[--color-accent]/15 text-[--color-accent]",
				secondary: "bg-[--color-surface-2] text-[--color-text-muted]",
				destructive: "bg-red-500/15 text-red-400",
				outline: "border border-[--color-border] text-[--color-text-muted]",
				success: "bg-emerald-500/15 text-emerald-400",
				warning: "bg-amber-500/15 text-amber-400",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

interface BadgeProps
	extends HTMLAttributes<HTMLSpanElement>,
		VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
	return (
		<span className={cn(badgeVariants({ variant }), className)} {...props} />
	);
}
