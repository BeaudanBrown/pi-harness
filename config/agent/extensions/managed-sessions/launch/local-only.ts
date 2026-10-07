import { CURRENT_SESSION_VERSION, parseSessionEntries, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLocalNavigationGuard } from "./local-guard.js";

/** Guard ordinary native navigation; explicit local-only omits the managed adapter. */
export default function localOnlyGuard(pi: ExtensionAPI): void {
	registerLocalNavigationGuard(pi, { CURRENT_SESSION_VERSION, parseSessionEntries }, process.env.PI_HARNESS_LOCAL_SESSION_ROOT);
}
