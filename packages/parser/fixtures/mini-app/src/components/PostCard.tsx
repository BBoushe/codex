// Imports Avatar and Button from siblings (same folder)
// Imports summarizePost from the @/api barrel — exercises named re-export through alias
import { useState } from "react";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { summarizePost, deletePost } from "@/api";
import type { Post } from "@/api";

interface PostCardProps {
	post: Post;
	authorName: string;
	authorAvatarSrc: string | null;
	onDeleted: (id: string) => void;
}

export function PostCard({ post, authorName, authorAvatarSrc, onDeleted }: PostCardProps) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const summary = summarizePost(post);

	const handleDelete = async () => {
		setDeleting(true);
		try {
			await deletePost(post.id);
			onDeleted(post.id);
		} finally {
			setDeleting(false);
			setConfirmOpen(false);
		}
	};

	return (
		<article className="post-card">
			<header className="post-card-header">
				<Avatar src={authorAvatarSrc} size={24} />
				<span className="post-author">{authorName}</span>
				<time className="post-date">{summary.formattedDate}</time>
			</header>
			<h3 className="post-title">{summary.title}</h3>
			<p className="post-excerpt">{summary.excerpt}</p>
			<footer className="post-card-footer">
				<Button
					label="Delete"
					onClick={() => setConfirmOpen(true)}
					variant="danger"
					disabled={deleting}
				/>
			</footer>
			<Modal
				title="Delete post?"
				isOpen={confirmOpen}
				onClose={() => setConfirmOpen(false)}
				onConfirm={handleDelete}
				confirmLabel="Delete"
			>
				<p>Are you sure you want to delete &ldquo;{post.title}&rdquo;? This cannot be undone.</p>
			</Modal>
		</article>
	);
}
