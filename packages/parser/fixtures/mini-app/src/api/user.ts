import { formatName } from "@/utils/format";

export interface User {
	id: string;
	firstName: string;
	lastName: string;
}

export async function fetchUser(id: string): Promise<User> {
	const res = await fetch(`/api/users/${id}`);
	return res.json();
}

export function getDisplayName(user: User): string {
	return formatName(user.firstName, user.lastName);
}
