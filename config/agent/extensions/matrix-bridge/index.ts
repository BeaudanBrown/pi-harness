import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installAdapter } from "./adapter.js";
import { installPresentation } from "./presentation.js";
export default function (pi: ExtensionAPI): void { installPresentation(pi); installAdapter(pi); }
