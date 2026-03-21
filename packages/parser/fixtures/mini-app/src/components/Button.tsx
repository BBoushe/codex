interface ButtonProps {
	label: string;
	onClick: () => void;
	variant?: "primary" | "secondary" | "danger";
	disabled?: boolean;
	fullWidth?: boolean;
	type?: "button" | "submit" | "reset";
}

export function Button({
	label,
	onClick,
	variant = "primary",
	disabled = false,
	fullWidth = false,
	type = "button",
}: ButtonProps) {
	const className = [
		"btn",
		`btn-${variant}`,
		fullWidth ? "btn-full" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<button className={className} onClick={onClick} disabled={disabled} type={type}>
			{label}
		</button>
	);
}
