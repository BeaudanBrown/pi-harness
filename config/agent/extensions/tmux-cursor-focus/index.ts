import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const TMUX_PANE = process.env.TMUX_PANE;
const HOOK_ID = process.pid;
const STATE_DIR = join(tmpdir(), "pi-harness-tmux-cursor-focus");
const STATE_FILE = TMUX_PANE
	? join(STATE_DIR, `pane-${TMUX_PANE.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${HOOK_ID}.state`)
	: undefined;
const TMUX_TIMEOUT_MS = 500;
const WRAP_GUARD_INTERVAL_MS = 1000;
const WRAPPED_EDITOR = Symbol("piHarnessTmuxCursorFocusWrapped");

interface FocusAwareEditor extends EditorComponent {
	focused?: boolean;
	setTmuxFocus(focused: boolean): void;
}

interface ExtensionEditorComponent extends EditorComponent {
	focused?: boolean;
	wantsKeyRelease?: boolean;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	actionHandlers?: Map<string, () => void>;
	onAction?: (action: string, handler: () => void) => void;
}

type WrappedEditorFactory = ExtensionContext["ui"]["getEditorComponent"] extends () => infer Factory ? NonNullable<Factory> : never;
type MarkedEditorFactory = WrappedEditorFactory & { [WRAPPED_EDITOR]?: true };

interface TmuxCursorFocusState {
	currentWrapper?: FocusAwareEditor;
	isTmuxFocused: boolean;
	hooksInstalled: boolean;
	stateWatcher?: FSWatcher;
	wrapGuardTimer?: NodeJS.Timeout;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const REVERSE_VIDEO_CURSOR_RE = /\x1b\[[0-9;]*7m([\s\S]?)\x1b\[[0-9;]*(?:0|27)m/;

function cursorReplacement(highlightedChar: string, trailingText: string): string {
	if (highlightedChar === " " && /^\s*$/.test(trailingText)) return "";
	return highlightedChar;
}

function replaceCursorMatch(text: string, match: RegExpMatchArray | null): string {
	if (!match || match.index === undefined) return text;

	const beforeCursor = text.slice(0, match.index);
	const highlightedChar = match[1] ?? "";
	const trailingText = text.slice(match.index + match[0].length);
	return beforeCursor + cursorReplacement(highlightedChar, trailingText) + trailingText;
}

export function stripFakeCursor(line: string): string {
	const markerIndex = line.indexOf(CURSOR_MARKER);
	if (markerIndex === -1) return replaceCursorMatch(line, line.match(REVERSE_VIDEO_CURSOR_RE));

	const withoutMarker = line.replace(CURSOR_MARKER, "");
	const afterMarker = withoutMarker.slice(markerIndex);
	const match = afterMarker.match(REVERSE_VIDEO_CURSOR_RE);
	if (!match || match.index !== 0) return withoutMarker;

	const strippedAfterMarker = replaceCursorMatch(afterMarker, match);
	return withoutMarker.slice(0, markerIndex) + strippedAfterMarker;
}

class FocusAwareEditorWrapper implements FocusAwareEditor {
	private uiFocused = true;
	private tmuxFocused = true;
	private readonly actionHandlers = new Map<string, () => void>();

	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;

	constructor(
		private readonly tui: TUI,
		private readonly inner: ExtensionEditorComponent,
	) {
		this.syncInnerFocus();
	}

	get focused(): boolean {
		return this.uiFocused;
	}

	set focused(value: boolean) {
		this.uiFocused = value;
		this.syncInnerFocus();
	}

	get wantsKeyRelease(): boolean {
		return this.inner.wantsKeyRelease ?? false;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.inner.borderColor;
	}

	set borderColor(value: ((str: string) => string) | undefined) {
		this.inner.borderColor = value;
	}

	private syncInnerFocus(): void {
		if ("focused" in this.inner) {
			this.inner.focused = this.uiFocused && this.tmuxFocused;
		}
	}

	setTmuxFocus(focused: boolean): void {
		if (this.tmuxFocused === focused) return;
		this.tmuxFocused = focused;
		this.syncInnerFocus();
		this.invalidate();
		this.tui.requestRender();
	}

	onAction(action: string, handler: () => void): void {
		this.actionHandlers.set(action, handler);
		this.inner.onAction?.(action, handler);
	}

	private syncInnerCallbacks(): void {
		this.inner.onSubmit = this.onSubmit;
		this.inner.onChange = this.onChange;
		this.inner.onEscape = this.onEscape;
		this.inner.onCtrlD = this.onCtrlD;
		this.inner.onPasteImage = this.onPasteImage;
		this.inner.onExtensionShortcut = this.onExtensionShortcut;

		if (this.inner.actionHandlers instanceof Map) {
			for (const [action, handler] of this.actionHandlers) {
				this.inner.actionHandlers.set(action, handler);
			}
		}
	}

	getText(): string {
		return this.inner.getText();
	}

	setText(text: string): void {
		this.syncInnerCallbacks();
		this.inner.setText(text);
	}

	getExpandedText(): string {
		return this.inner.getExpandedText?.() ?? this.getText();
	}

	addToHistory(text: string): void {
		this.inner.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.inner.insertTextAtCursor?.(text);
	}

	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.inner.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.inner.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.inner.setAutocompleteMaxVisible?.(maxVisible);
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (this.tmuxFocused) return lines;
		return lines.map(stripFakeCursor);
	}

	handleInput(data: string): void {
		this.syncInnerCallbacks();
		this.inner.handleInput(data);
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}
}

class FocusAwareDefaultEditor extends CustomEditor implements FocusAwareEditor {
	private tmuxFocused = true;

	setTmuxFocus(focused: boolean): void {
		if (this.tmuxFocused === focused) return;
		this.tmuxFocused = focused;
		this.focused = focused;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (this.tmuxFocused) return lines;
		return lines.map(stripFakeCursor);
	}
}

function ensureWrappedFactory(ctx: ExtensionContext, state: TmuxCursorFocusState): void {
	if (!ctx.hasUI || !TMUX_PANE) return;

	const currentFactory = ctx.ui.getEditorComponent() as MarkedEditorFactory | undefined;
	if (currentFactory?.[WRAPPED_EDITOR]) return;

	let wrappedFactory: MarkedEditorFactory;
	if (currentFactory) {
		const previousFactory = currentFactory;
		wrappedFactory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const inner = previousFactory(tui, theme, keybindings) as ExtensionEditorComponent;
			const wrapper = new FocusAwareEditorWrapper(tui, inner);
			state.currentWrapper = wrapper;
			wrapper.setTmuxFocus(state.isTmuxFocused);
			return wrapper;
		}) as MarkedEditorFactory;
	} else {
		wrappedFactory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const wrapper = new FocusAwareDefaultEditor(tui, theme, keybindings);
			state.currentWrapper = wrapper;
			wrapper.setTmuxFocus(state.isTmuxFocused);
			return wrapper;
		}) as MarkedEditorFactory;
	}

	wrappedFactory[WRAPPED_EDITOR] = true;
	ctx.ui.setEditorComponent(wrappedFactory);
}

async function runTmux(pi: ExtensionAPI, args: string[]) {
	return pi.exec("tmux", args, { timeout: TMUX_TIMEOUT_MS });
}

async function readCurrentPaneFocus(pi: ExtensionAPI): Promise<boolean> {
	if (!TMUX_PANE) return true;
	try {
		const result = await runTmux(pi, ["display-message", "-p", "-t", TMUX_PANE, "#{pane_active}"]);
		return result.stdout.trim() !== "0";
	} catch {
		return true;
	}
}

async function applyStateFromFile(state: TmuxCursorFocusState): Promise<void> {
	if (!STATE_FILE) return;
	try {
		const nextFocused = (await readFile(STATE_FILE, "utf8")).trim() !== "0";
		if (nextFocused === state.isTmuxFocused) return;
		state.isTmuxFocused = nextFocused;
		state.currentWrapper?.setTmuxFocus(nextFocused);
	} catch {
		// Ignore transient read errors while tmux updates the state file.
	}
}

function hookCommand(value: "0" | "1"): string {
	return `run-shell -b "printf %s ${value} > ${shellQuote(STATE_FILE ?? "")}"`;
}

async function installHooks(pi: ExtensionAPI, state: TmuxCursorFocusState): Promise<void> {
	if (!TMUX_PANE || !STATE_FILE || state.hooksInstalled) return;
	await mkdir(STATE_DIR, { recursive: true });
	state.isTmuxFocused = await readCurrentPaneFocus(pi);
	await writeFile(STATE_FILE, state.isTmuxFocused ? "1" : "0");
	await runTmux(pi, ["set-hook", "-p", "-t", TMUX_PANE, `pane-focus-in[${HOOK_ID}]`, hookCommand("1")]);
	await runTmux(pi, ["set-hook", "-p", "-t", TMUX_PANE, `pane-focus-out[${HOOK_ID}]`, hookCommand("0")]);
	state.hooksInstalled = true;
}

async function uninstallHooks(pi: ExtensionAPI, state: TmuxCursorFocusState): Promise<void> {
	if (!TMUX_PANE || !state.hooksInstalled) return;
	await Promise.allSettled([
		runTmux(pi, ["set-hook", "-up", "-t", TMUX_PANE, `pane-focus-in[${HOOK_ID}]`]),
		runTmux(pi, ["set-hook", "-up", "-t", TMUX_PANE, `pane-focus-out[${HOOK_ID}]`]),
	]);
	state.hooksInstalled = false;
}

async function startWatching(state: TmuxCursorFocusState): Promise<void> {
	if (!STATE_FILE || state.stateWatcher) return;
	state.stateWatcher = watch(STATE_FILE, { persistent: false }, () => {
		void applyStateFromFile(state);
	});
	state.stateWatcher.on("error", () => {
		state.stateWatcher?.close();
		state.stateWatcher = undefined;
	});
}

async function stopWatching(state: TmuxCursorFocusState): Promise<void> {
	state.stateWatcher?.close();
	state.stateWatcher = undefined;
	if (!STATE_FILE) return;
	await rm(STATE_FILE, { force: true });
}

async function startMonitoring(pi: ExtensionAPI, state: TmuxCursorFocusState): Promise<void> {
	if (!TMUX_PANE || !STATE_FILE) return;
	await installHooks(pi, state);
	await startWatching(state);
	await applyStateFromFile(state);
}

async function stopMonitoring(pi: ExtensionAPI, state: TmuxCursorFocusState): Promise<void> {
	await uninstallHooks(pi, state);
	await stopWatching(state);
}

export default function tmuxCursorFocusExtension(pi: ExtensionAPI): void {
	const state: TmuxCursorFocusState = {
		isTmuxFocused: true,
		hooksInstalled: false,
	};

	const ensureWrapped = (ctx: ExtensionContext): void => ensureWrappedFactory(ctx, state);

	const startWrapGuard = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || !TMUX_PANE || state.wrapGuardTimer) return;
		state.wrapGuardTimer = setInterval(() => {
			ensureWrapped(ctx);
		}, WRAP_GUARD_INTERVAL_MS);
	};

	const stopWrapGuard = (): void => {
		if (state.wrapGuardTimer) {
			clearInterval(state.wrapGuardTimer);
			state.wrapGuardTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || !TMUX_PANE) return;
		ensureWrapped(ctx);
		startWrapGuard(ctx);
		await startMonitoring(pi, state);
	});

	pi.on("session_shutdown", async () => {
		state.currentWrapper = undefined;
		stopWrapGuard();
		await stopMonitoring(pi, state);
	});
}
