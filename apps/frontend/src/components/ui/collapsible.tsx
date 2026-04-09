import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleProps {
	title: string;
	count?: number;
	defaultOpen?: boolean;
	children: ReactNode;
	className?: string;
	headerClassName?: string;
}

export function Collapsible({
	title,
	count,
	defaultOpen = false,
	children,
	className,
	headerClassName,
}: CollapsibleProps) {
	const [open, setOpen] = useState(defaultOpen);

	return (
		<div className={cn("border-b border-[var(--color-border)]", className)}>
			<button
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"w-full flex items-center justify-between px-4 py-2.5",
					"text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider",
					"hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors",
					"focus:outline-none focus-visible:bg-[var(--color-surface-2)]",
					headerClassName,
				)}
			>
				<span>
					{title}
					{count !== undefined && (
						<span className="ml-1.5 text-[var(--color-text-subtle)]">({count})</span>
					)}
				</span>
				<ChevronDown
					size={12}
					className={cn(
						"shrink-0 transition-transform duration-200 text-[var(--color-text-subtle)]",
						open && "rotate-180",
					)}
				/>
			</button>
			{open && (
				<div className="animate-fade-in">
					{children}
				</div>
			)}
		</div>
	);
}
