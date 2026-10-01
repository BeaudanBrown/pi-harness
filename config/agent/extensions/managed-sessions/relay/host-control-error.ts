import { HOST_CONTROL_VERSION, HOST_ERROR_EXITS, type HostErrorCode, type HostErrorResponse } from "../live-workspace-contracts.js";

/** Only explicitly public diagnostics may cross the control transport. */
export class HostControlError extends Error {
	constructor(readonly code: HostErrorCode, message: string, readonly retryable = false) { super(message); }
}

export function hostErrorResponse(requestId: string, error: unknown): HostErrorResponse {
	const publicError = error instanceof HostControlError && Object.hasOwn(HOST_ERROR_EXITS, error.code) && error.message.length > 0 && error.message.length <= 512
		? error : new HostControlError("failed", "Host operation failed");
	return { version: HOST_CONTROL_VERSION, requestId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId) ? requestId : "invalid-request", ok: false,
		error: { code: publicError.code, message: publicError.message, retryable: publicError.retryable === true } };
}
