import { App, Plugin, PluginSettingTab, Setting, FuzzySuggestModal } from 'obsidian';

// Projects Memory plugin: settings and UI for comma-separated project tags

interface ProjectsMemorySettings {
	projectTags: string;
}

const DEFAULT_SETTINGS: ProjectsMemorySettings = {
	projectTags: 'projet'
}

export default class ProjectsMemoryPlugin extends Plugin {
	settings: ProjectsMemorySettings;

	async onload() {
		await this.loadSettings();

		// Create an icon in the left ribbon that lists project files when clicked
		const ribbonIconEl = this.addRibbonIcon('rocket', 'Review projects', (_evt: MouseEvent) => {
			const projectTagsStr = this.settings.projectTags ?? '';

			// Build array of tags with a leading '#', robust to spaces and empty values
			const tagsArray = projectTagsStr
				.split(',')
				.map(t => t.trim())
				.filter(Boolean)
				.map(t => (t.startsWith('#') ? t : `#${t}`));

			if (tagsArray.length === 0) {
				console.log([]);
				return;
			}

			const mdFiles = this.app.vault.getMarkdownFiles();

			const matchedNames = mdFiles
				.filter((file) => {
					const cache = this.app.metadataCache.getFileCache(file);
					if (!cache || !cache.tags) return false;
					// A file is a project if it contains at least one of the configured tags
					return cache.tags.some((t) => tagsArray.includes(t.tag));
				})
				.map((file) => file.basename);

			console.log(matchedNames);
		});
		ribbonIconEl.addClass('projects-memory-ribbon-class');

		// Settings tab
		this.addSettingTab(new ProjectsMemorySettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// Simple debouncer utility
function debounce<Func extends (...args: any[]) => void>(fn: Func, wait = 200) {
	let t: number | null = null;
	return (...args: Parameters<Func>) => {
		if (t) window.clearTimeout(t);
		t = window.setTimeout(() => fn(...args), wait) as unknown as number;
	};
}

// Suggest modal that inserts chosen tag into the target input element
class TagsSuggestModal extends FuzzySuggestModal<string> {
	private itemsList: string[];
	private targetInputEl: HTMLInputElement;
	private plugin: ProjectsMemoryPlugin;

	constructor(app: App, items: string[], targetInputEl: HTMLInputElement, plugin: ProjectsMemoryPlugin) {
		super(app);
		this.itemsList = items;
		this.targetInputEl = targetInputEl;
		this.plugin = plugin;
	}

	getItems(): string[] {
		return this.itemsList;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string, _evt: MouseEvent | KeyboardEvent) {
		// Append chosen tag to the input value as a comma-terminated token
		const current = this.targetInputEl.value;
		const parts = current.split(',');
		// Replace last token (in-progress) with the chosen tag
		parts[parts.length - 1] = ' ' + item;
		const newVal = parts.map(p => p.trim()).filter(Boolean).join(', ') + ', ';
		this.targetInputEl.value = newVal;
		// Persist to plugin settings (store without trailing comma)
		this.plugin.settings.projectTags = newVal.replace(/\s*,\s*$/, '');
		this.plugin.saveSettings();
		this.targetInputEl.focus();
	}
}

class ProjectsMemorySettingTab extends PluginSettingTab {
	plugin: ProjectsMemoryPlugin;

	constructor(app: App, plugin: ProjectsMemoryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Gather all tags from the metadata cache (cache-only scan for performance)
		const tagSet = new Set<string>();
		this.app.vault.getMarkdownFiles().forEach((file) => {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache || !cache.tags) return;
			cache.tags.forEach((t) => {
				const normalized = t.tag.replace(/^#/, '');
				if (normalized) tagSet.add(normalized);
			});
		});
		const availableTags = Array.from(tagSet);

		new Setting(containerEl)
			.setName('Project tags')
			.setDesc('Comma-separated list of tags identifying project files; do not include the leading #.')
			.addText(text => {
				text
					.setPlaceholder('projet')
					.setValue(this.plugin.settings.projectTags)
					.onChange(async (value) => {
						this.plugin.settings.projectTags = value;
						await this.plugin.saveSettings();
					});

				// Suggest modal: open when user types (debounced) to show matching tags from cache
				const openSuggest = debounce(() => {
					const value = text.getValue();
					// compute current token (the last comma-separated part)
					const tokens = value.split(',');
					const currentToken = tokens[tokens.length - 1].trim();
					if (!currentToken) return;
					// filter available tags by currentToken (case-insensitive)
					const matches = availableTags.filter(t => t.toLowerCase().includes(currentToken.toLowerCase()));
					if (matches.length === 0) return;
					const modal = new TagsSuggestModal(this.app, matches, text.inputEl, this.plugin);
					modal.open();
				}, 150);

				text.inputEl.addEventListener('input', () => openSuggest());
			});
	}
}
