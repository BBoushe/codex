// Uses the @/utils barrel (export * chain) rather than the direct file path
import { formatName } from "@/utils";

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
