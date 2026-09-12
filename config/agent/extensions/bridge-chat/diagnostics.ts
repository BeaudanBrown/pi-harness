import { MatrixError } from "../matrix-shared/http.js";

export type TransportStage = "configuration" | "credential_read" | "matrix_client" | "identity_request" | "identity_validation" | "database_open" | "policy_initialization" | "running";

const SAFE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR", "ENOSPC", "EROFS", "EIO", "ERR_SQLITE_ERROR", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE"]);

/** Never serialize errors: messages, stacks, causes and arbitrary codes may contain secrets. */
export function transportFailure(stage: TransportStage, error: unknown): string {
	let code = "unknown";
	let httpStatus: number | undefined;
	if (error instanceof MatrixError) {
		if (["cancelled", "http", "invalid_response", "network"].includes(error.code)) code = error.code;
		if (Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599) httpStatus = error.status;
	} else if (error instanceof Error) {
		const candidate = (error as NodeJS.ErrnoException).code;
		if (typeof candidate === "string" && SAFE_CODES.has(candidate)) code = candidate;
		else if (error instanceof SyntaxError) code = "syntax_error";
	}
	return JSON.stringify({ event: "transport_failed", stage, code, ...(httpStatus === undefined ? {} : { httpStatus }) });
}
