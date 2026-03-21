// Imports from the @/api barrel — exercises named re-export chain through alias
import { useState, useEffect, useCallback } from "react";
import { fetchUser } from "@/api";
import type { User } from "@/api";

interface UseUserState {
	user: User | null;
	loading: boolean;
	error: string | null;
}

export function useUser(userId: string | null) {
	const [state, setState] = useState<UseUserState>({
		user: null,
		loading: false,
		error: null,
	});

	const load = useCallback(async () => {
		if (!userId) return;
		setState((prev) => ({ ...prev, loading: true, error: null }));
		try {
			const user = await fetchUser(userId);
			setState({ user, loading: false, error: null });
		} catch (err) {
			setState((prev) => ({
				...prev,
				loading: false,
				error: err instanceof Error ? err.message : "Unknown error",
			}));
		}
	}, [userId]);

	useEffect(() => {
		load();
	}, [load]);

	return { ...state, reload: load };
}
