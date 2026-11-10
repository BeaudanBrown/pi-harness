import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installAdapter } from "./adapter.js";
export default function (pi: ExtensionAPI): void { installAdapter(pi); }
