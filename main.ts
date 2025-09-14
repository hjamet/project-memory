import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	projectTag: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	projectTag: '#projet'
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// Create an icon in the left ribbon that lists project files when clicked
		const ribbonIconEl = this.addRibbonIcon('rocket', 'Review projects', (_evt: MouseEvent) => {
			const projectTag = this.settings.projectTag;

			const mdFiles = this.app.vault.getMarkdownFiles();

			const matchedNames = mdFiles
				.filter((file) => {
					const cache = this.app.metadataCache.getFileCache(file);
					if (!cache || !cache.tags) return false;
					return cache.tags.some((t) => t.tag === projectTag);
				})
				.map((file) => file.basename);

			console.log(matchedNames);
		});
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// Settings tab
		this.addSettingTab(new SampleSettingTab(this.app, this));
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

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Project tag')
			.setDesc('Tag used to identify project files (include the leading #, e.g. "#projet").')
			.addText(text => text
				.setPlaceholder('#projet')
				.setValue(this.plugin.settings.projectTag)
				.onChange(async (value) => {
					this.plugin.settings.projectTag = value;
					await this.plugin.saveSettings();
				}));
	}
}
