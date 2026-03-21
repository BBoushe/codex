import { useEffect } from "react";
import { Button } from "./Button";

interface ModalProps {
	title: string;
	children: React.ReactNode;
	isOpen: boolean;
	onClose: () => void;
	onConfirm?: () => void;
	confirmLabel?: string;
	cancelLabel?: string;
}

export function Modal({
	title,
	children,
	isOpen,
	onClose,
	onConfirm,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
}: ModalProps) {
	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<h2>{title}</h2>
					<button className="modal-close" onClick={onClose}>
						&times;
					</button>
				</div>
				<div className="modal-body">{children}</div>
				<div className="modal-footer">
					<Button label={cancelLabel} onClick={onClose} variant="secondary" />
					{onConfirm && (
						<Button label={confirmLabel} onClick={onConfirm} variant="primary" />
					)}
				</div>
			</div>
		</div>
	);
}
