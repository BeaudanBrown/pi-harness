import type { Api, Model } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { workerModelSearchText } from "./core.js";

type WorkerModelItem = {
	model: Model<Api>;
	modelRef: string;
};

class WorkerModelSelector extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private filteredItems: WorkerModelItem[];
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		private readonly tui: TUI,
		private readonly keybindings: KeybindingsManager,
		private readonly items: WorkerModelItem[],
		private readonly currentModelRef: string | undefined,
		private readonly color: (name: "accent" | "dim" | "muted" | "success" | "warning", text: string) => string,
		private readonly done: (modelRef: string | undefined) => void,
	) {
		super();
		this.filteredItems = items;
		this.selectedIndex = Math.max(0, items.findIndex((item) => item.modelRef === currentModelRef));

		this.addChild(new DynamicBorder((text: string) => this.color("accent", text)));
		this.addChild(new Text(this.color("accent", "Select Worker Model"), 1, 0));
		this.addChild(new Text(this.color("dim", "Type to fuzzy search registered, authenticated models"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.color("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		this.addChild(new DynamicBorder((text: string) => this.color("accent", text)));

		this.searchInput.onSubmit = () => this.selectCurrent();
		this.updateList();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.filteredItems.length > 0) {
				this.selectedIndex =
					this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
				this.updateList();
			}
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.filteredItems.length > 0) {
				this.selectedIndex =
					this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
				this.updateList();
			}
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.selectCurrent();
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		} else {
			this.searchInput.handleInput(data);
			this.filter(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}

	private filter(query: string): void {
		this.filteredItems = query
			? fuzzyFilter(this.items, query, (item) => workerModelSearchText(item.model))
			: this.items;
		this.selectedIndex = 0;
		this.updateList();
	}

	private selectCurrent(): void {
		const selected = this.filteredItems[this.selectedIndex];
		if (selected) this.done(selected.modelRef);
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.color("warning", "  No matching models"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredItems.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.filteredItems.length);
		for (let index = start; index < end; index += 1) {
			const item = this.filteredItems[index];
			if (!item) continue;
			const selected = index === this.selectedIndex;
			const current = item.modelRef === this.currentModelRef;
			const prefix = selected ? this.color("accent", "→ ") : "  ";
			const modelRef = selected ? this.color("accent", item.modelRef) : item.modelRef;
			const name = this.color("muted", item.model.name);
			const marker = current ? this.color("success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${modelRef}  ${name}${marker}`, 0, 0));
		}
		if (start > 0 || end < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(this.color("dim", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}
	}
}

export async function selectWorkerModel(
	ctx: ExtensionContext,
	currentModelRef: string | undefined,
): Promise<string | undefined> {
	ctx.modelRegistry.refresh();
	const loadError = ctx.modelRegistry.getError();
	if (loadError) ctx.ui.notify(`worker-model: ${loadError}`, "warning");

	const items = ctx.modelRegistry
		.getAvailable()
		.map((model) => ({ model, modelRef: `${model.provider}/${model.id}` }))
		.sort((left, right) => {
			if (left.modelRef === currentModelRef) return -1;
			if (right.modelRef === currentModelRef) return 1;
			return left.model.provider.localeCompare(right.model.provider) || left.model.id.localeCompare(right.model.id);
		});

	if (items.length === 0) {
		ctx.ui.notify("worker-model: no registered models have configured authentication", "warning");
		return undefined;
	}

	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
		new WorkerModelSelector(
			tui,
			keybindings,
			items,
			currentModelRef,
			(name, text) => theme.fg(name, text),
			done,
		),
	);
}
