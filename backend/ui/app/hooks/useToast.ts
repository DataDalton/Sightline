"use client";

import { useState, useCallback } from "react";

interface ToastState {
	message: string;
	type: "success" | "error" | "warning";
	visible: boolean;
}

export function useToast() {
	const [toast, setToast] = useState<ToastState>({
		message: "",
		type: "success",
		visible: false,
	});

	const showToast = useCallback(
		(
			message: string,
			type: "success" | "error" | "warning" = "success",
		) => {
			setToast({ message, type, visible: true });
		},
		[],
	);

	const hideToast = useCallback(() => {
		setToast((prev) => ({ ...prev, visible: false }));
	}, []);

	return { toast, showToast, hideToast };
}
