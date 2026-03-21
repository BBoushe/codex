// Imports siblings directly (same folder — no barrel needed)
// Imports custom hook from the @/hooks barrel
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { useUser } from "@/hooks";

interface HeaderProps {
	title: string;
	currentUserId: string | null;
	onLogout: () => void;
	onHome: () => void;
}

export function Header({ title, currentUserId, onLogout, onHome }: HeaderProps) {
	const { user } = useUser(currentUserId);

	return (
		<header className="app-header">
			<div className="header-brand" onClick={onHome}>
				<h1>{title}</h1>
			</div>
			<nav className="header-nav">
				{user && (
					<div className="header-user">
						<Avatar src={user.avatar ?? null} size={32} />
						<span className="header-username">{user.name}</span>
					</div>
				)}
				<Button label="Logout" onClick={onLogout} variant="secondary" />
			</nav>
		</header>
	);
}
