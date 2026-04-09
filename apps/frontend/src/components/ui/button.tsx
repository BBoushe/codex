import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	[
		"inline-flex items-center justify-center gap-1.5 font-medium",
		"transition-all duration-200 cursor-pointer",
		"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
		"focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-background)]",
		"disabled:pointer-events-none disabled:opacity-50",
		"active:scale-[0.97]",
	].join(" "),
	{
		variants: {
			variant: {
				primary: [
					"bg-[var(--color-accent)] text-white border border-transparent",
					"shadow-(--shadow-xs) hover:shadow-(--shadow-sm)",
					"hover:bg-[var(--color-accent-hover)]",
				].join(" "),
				secondary: [
					"bg-transparent text-[var(--color-text)] border border-[var(--color-border)]",
					"shadow-(--shadow-xs) hover:shadow-(--shadow-sm)",
					"hover:border-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]",
				].join(" "),
				ghost: [
					"bg-transparent text-[var(--color-text-muted)] border-none shadow-none",
					"hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]",
				].join(" "),
				accent: [
					"bg-transparent text-[var(--color-accent)] border border-[var(--color-accent)]/30",
					"hover:bg-[var(--color-accent)]/10 hover:border-[var(--color-accent)]/50",
				].join(" "),
				danger: [
					"bg-red-500/10 text-red-400 border border-red-500/20",
					"hover:bg-red-500/20 hover:border-red-500/40",
				].join(" "),
			},
			size: {
				xs: "h-6 px-2 text-[10px] rounded-[4px]",
				sm: "h-7 px-2.5 text-xs rounded-[4px]",
				md: "h-8 px-3 text-xs rounded-[4px]",
				lg: "h-9 px-4 text-sm rounded-[6px]",
				icon: "h-8 w-8 rounded-[4px]",
				"icon-sm": "h-7 w-7 rounded-[4px]",
			},
		},
		defaultVariants: { variant: "secondary", size: "md" },
	},
);

interface ButtonProps
	extends ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
	return (
		<button
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}

export { buttonVariants };
