import { useState, useEffect } from "react";
// Uses the @/api barrel (named re-export chain) rather than direct file path
import { fetchUser } from "@/api";
import { Avatar } from "./Avatar";

interface UserCardProps {
	userId: string;
	onSelect?: (id: string) => void;
	compact?: boolean;
}

export function UserCard({ userId, onSelect, compact }: UserCardProps) {
	const [user, setUser] = useState(null);

	useEffect(() => {
		fetchUser(userId).then(setUser);
	}, [userId]);

	if (compact) {
		return (
			<div onClick={() => onSelect?.(userId)}>
				<span>{user?.name}</span>
			</div>
		);
	} else {
		return (
			<div onClick={() => onSelect?.(userId)}>
				<Avatar src={user?.avatar} />
				<span>{user?.name}</span>
			</div>
		);
	}
}
