// Uses the utils barrel — exercises export* chain through tsconfig alias
import { formatDate, truncate } from "@/utils";

export interface Post {
	id: string;
	authorId: string;
	title: string;
	body: string;
	createdAt: Date;
}

export interface PostSummary {
	id: string;
	title: string;
	authorId: string;
	excerpt: string;
	formattedDate: string;
}

export async function fetchPosts(authorId?: string): Promise<Post[]> {
	const url = authorId ? `/api/posts?authorId=${authorId}` : "/api/posts";
	const res = await fetch(url);
	return res.json();
}

export async function fetchPost(id: string): Promise<Post> {
	const res = await fetch(`/api/posts/${id}`);
	return res.json();
}

export async function createPost(
	title: string,
	body: string,
	authorId: string,
): Promise<Post> {
	const res = await fetch("/api/posts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, body, authorId }),
	});
	return res.json();
}

export async function deletePost(id: string): Promise<void> {
	await fetch(`/api/posts/${id}`, { method: "DELETE" });
}

export function summarizePost(post: Post): PostSummary {
	return {
		id: post.id,
		title: post.title,
		authorId: post.authorId,
		excerpt: truncate(post.body, 120),
		formattedDate: formatDate(post.createdAt),
	};
}
