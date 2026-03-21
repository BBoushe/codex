import { useState } from "react";
// Imports multiple components through the @/components barrel
import { Header, PostList, UserCard } from "@/components";

export default function App() {
	const [currentUserId, setCurrentUserId] = useState<string | null>("1");
	const [selectedUserId, setSelectedUserId] = useState("1");

	const handleLogout = () => {
		setCurrentUserId(null);
	};

	if (!currentUserId) {
		return <div className="logged-out">You are logged out.</div>;
	}

	return (
		<div className="app">
			<Header
				title="Mini App"
				currentUserId={currentUserId}
				onLogout={handleLogout}
				onHome={() => setSelectedUserId("1")}
			/>
			<main className="app-main">
				<UserCard
					userId={selectedUserId}
					onSelect={setSelectedUserId}
				/>
				<PostList
					authorId={selectedUserId}
					authorName="Selected User"
					authorAvatarSrc={null}
				/>
			</main>
		</div>
	);
}
