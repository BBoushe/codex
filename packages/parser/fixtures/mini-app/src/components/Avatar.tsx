interface AvatarProps {
	src: string | null;
	size?: number;
}

export function Avatar({ src, size = 40 }: AvatarProps) {
	if (!src) return <div className="avatar-placeholder" />;
	return <img src={src} width={size} height={size} />;
}
