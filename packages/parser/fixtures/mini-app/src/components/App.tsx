import { useState } from "react";
import { UserCard } from "./UserCard";

export default function App() {
	const [selectedId, setSelectedId] = useState("1");

	return (
		<div>
			<UserCard userId={selectedId} onSelect={setSelectedId} />
			<UserCard userId="2" compact />
		</div>
	);
}
