// Imports PostCard from sibling; fetchPosts from @/api barrel
import { useState, useEffect } from "react";
import { PostCard } from "./PostCard";
import { fetchPosts } from "@/api";
import type { Post } from "@/api";

interface PostListProps {
	authorId?: string;
	authorName: string;
	authorAvatarSrc: string | null;
}

export function PostList({ authorId, authorName, authorAvatarSrc }: PostListProps) {
	const [posts, setPosts] = useState<Post[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setLoading(true);
		fetchPosts(authorId)
			.then((data) => {
				setPosts(data);
				setLoading(false);
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : "Failed to load posts");
				setLoading(false);
			});
	}, [authorId]);

	const handleDeleted = (id: string) => {
		setPosts((prev) => prev.filter((p) => p.id !== id));
	};

	if (loading) return <div className="post-list-loading">Loading posts…</div>;
	if (error) return <div className="post-list-error">{error}</div>;
	if (posts.length === 0) return <div className="post-list-empty">No posts yet.</div>;

	return (
		<section className="post-list">
			{posts.map((post) => (
				<PostCard
					key={post.id}
					post={post}
					authorName={authorName}
					authorAvatarSrc={authorAvatarSrc}
					onDeleted={handleDeleted}
				/>
			))}
		</section>
	);
}
