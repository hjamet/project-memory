import { App, Plugin, PluginSettingTab, Setting, AbstractInputSuggest, TFile } from 'obsidian';
import ReviewModal from './src/ReviewModal';
import StatsModal from './src/StatsModal';

// Projects Memory plugin: settings and UI for comma-separated project tags

interface ProjectsMemorySettings {
	projectTags: string;
	defaultScore: number;
	archiveTag: string;
	rotationBonus: number; // bonus points added to other projects when one is worked on
	rapprochmentFactor: number; // fraction between 0 and 1
	recencyPenaltyWeight: number; // multiplier for temporary per-session recency penalty
	scoresMigratedToStats: boolean; // migration flag for stats.json migration
	pomodoroDuration: number; // duration in minutes for Pomodoro
}

interface ProjectStats {
	currentScore: number; // current pertinence score stored in stats.json
	rotationBonus: number;
	totalReviews: number;
	lastReviewDate: string;
	reviewHistory: Array<{
		date: string;
		action: string; // "less-often" | "ok" | "more-often" | "finished"
		scoreAfter: number;
	}>;
}

interface GlobalStats {
	totalReviews: number;
	totalPomodoroTime: number; // in minutes
}

interface StatsData {
	projects: { [filePath: string]: ProjectStats };
	globalStats: GlobalStats;
}

const DEFAULT_SETTINGS: ProjectsMemorySettings = {
	projectTags: 'projet',
	defaultScore: 50,
	archiveTag: 'projet-fini',
	rotationBonus: 0.1,
	rapprochmentFactor: 0.2,
	recencyPenaltyWeight: 0.5,
	scoresMigratedToStats: false,
	pomodoroDuration: 25
}

export default class ProjectsMemoryPlugin extends Plugin {
	settings: ProjectsMemorySettings;
	public lastChosenFile: TFile | null = null;
	// Session-scoped set of ignored project file paths. Resets when plugin reloads.
	public sessionIgnoredProjects: Set<string> = new Set<string>();
	// Session-scoped map of review counts per file path. In-memory only; reset on plugin load.
	public sessionReviewCounts: Map<string, number> = new Map<string, number>();
	// Stats data loaded from stats.json
	private statsData: StatsData | null = null;

	async onload() {
		await this.loadSettings();
		// Load stats data at startup to ensure it's available when needed
		await this.loadStatsData();
		// Ensure per-session review counts are cleared on each plugin load (do not persist to disk)
		this.sessionReviewCounts.clear();
		// Run one-time migration to move scores from frontmatter to stats.json
		await this.migrateScoresToStats();

		// Create an icon in the left ribbon that lists project files when clicked
		const ribbonIconEl = this.addRibbonIcon('rocket', 'Review projects', (_evt: MouseEvent) => {
			new ReviewModal(this.app, this as any).open();
		});
		ribbonIconEl.addClass('projects-memory-ribbon-class');

		// Register review command
		this.addCommand({
			id: 'review-project',
			name: 'Review a project',
			callback: () => {
				new ReviewModal(this.app, this as any).open();
			}
		});

		// Register stats visualization command
		this.addCommand({
			id: 'view-stats',
			name: 'View project statistics',
			callback: () => {
				new StatsModal(this.app, this as any).open();
			}
		});

		// Settings tab
		this.addSettingTab(new ProjectsMemorySettingTab(this.app, this));
	}

	onunload() {
		// Save stats data when plugin unloads
		// Use synchronous approach to ensure data is saved before plugin unloads
		if (this.statsData) {
			try {
				// Force synchronous save by using the vault adapter directly
				const statsPath = `.obsidian/plugins/${this.manifest.id}/stats.json`;
				const content = JSON.stringify(this.statsData, null, 2);

				// Ensure the plugin directory exists before writing
				const pluginDir = `.obsidian/plugins/${this.manifest.id}`;
				const pluginDirExists = this.app.vault.adapter.exists(pluginDir);
				if (!pluginDirExists) {
					this.app.vault.adapter.mkdir(pluginDir);
				}

				this.app.vault.adapter.write(statsPath, content);
			} catch (error) {
				console.error('Failed to save stats data on unload:', error);
			}
		}
	}

	async loadSettings() {
		const loadedData = await this.loadData();

		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Load stats data from stats.json
	async loadStatsData(): Promise<StatsData> {
		if (this.statsData) {
			return this.statsData;
		}

		try {
			// Use the correct path for plugin data directory
			const statsPath = `.obsidian/plugins/${this.manifest.id}/stats.json`;

			// Use adapter.exists to check if file exists
			const fileExists = await this.app.vault.adapter.exists(statsPath);

			if (fileExists) {
				const content = await this.app.vault.adapter.read(statsPath);
				this.statsData = JSON.parse(content);
			} else {
				// Initialize empty stats only if no file exists
				this.statsData = {
					projects: {},
					globalStats: {
						totalReviews: 0,
						totalPomodoroTime: 0
					}
				};
				// Save the initialized empty stats to create the file
				await this.saveStatsData();
			}
		} catch (error) {
			console.error('Failed to load stats data:', error);
			console.error('Error details:', error);
			// Only initialize empty stats if we don't have any data loaded
			if (!this.statsData) {
				this.statsData = {
					projects: {},
					globalStats: {
						totalReviews: 0,
						totalPomodoroTime: 0
					}
				};
				// Save the initialized empty stats to create the file
				await this.saveStatsData();
			}
		}

		return this.statsData!;
	}

	// Save stats data to stats.json
	async saveStatsData(): Promise<void> {
		if (!this.statsData) return;

		try {
			// Use the correct path for plugin data directory
			const statsPath = `.obsidian/plugins/${this.manifest.id}/stats.json`;
			const content = JSON.stringify(this.statsData, null, 2);

			// Ensure the plugin directory exists before writing
			const pluginDir = `.obsidian/plugins/${this.manifest.id}`;
			const pluginDirExists = await this.app.vault.adapter.exists(pluginDir);
			if (!pluginDirExists) {
				await this.app.vault.adapter.mkdir(pluginDir);
			}

			await this.app.vault.adapter.write(statsPath, content);
		} catch (error) {
			console.error('Failed to save stats data:', error);
		}
	}

	// Get or create project stats
	async getProjectStats(filePath: string): Promise<ProjectStats> {
		const stats = await this.loadStatsData();

		if (!stats.projects[filePath]) {
			stats.projects[filePath] = {
				currentScore: this.settings.defaultScore,
				rotationBonus: 0,
				totalReviews: 0,
				lastReviewDate: '',
				reviewHistory: []
			};
		}

		return stats.projects[filePath];
	}

	// Get the current score for a project
	async getProjectScore(filePath: string): Promise<number> {
		const projectStats = await this.getProjectStats(filePath);
		return projectStats.currentScore;
	}

	// Update the current score for a project
	async updateProjectScore(filePath: string, newScore: number): Promise<void> {
		const stats = await this.loadStatsData();
		const projectStats = await this.getProjectStats(filePath);

		// Clamp score to [1, 100] range
		projectStats.currentScore = Math.min(100, Math.max(1, newScore));

		await this.saveStatsData();
	}

	// Increment rotation bonus for all projects except the excluded one
	async incrementRotationBonus(excludedPath: string): Promise<void> {
		const stats = await this.loadStatsData();
		const bonusAmount = this.settings.rotationBonus;

		// Add bonus to all projects except the excluded one
		for (const filePath in stats.projects) {
			if (filePath !== excludedPath) {
				stats.projects[filePath].rotationBonus += bonusAmount;
			}
		}

		// Note: totalReviews is incremented in recordReviewAction, not here
		// to avoid double counting

		await this.saveStatsData();
	}

	// Record a review action for a project
	async recordReviewAction(filePath: string, action: string, scoreAfter: number): Promise<void> {
		const stats = await this.loadStatsData();
		const projectStats = await this.getProjectStats(filePath);

		// Reset rotation bonus for the worked project
		projectStats.rotationBonus = 0;
		projectStats.totalReviews++;
		projectStats.lastReviewDate = new Date().toISOString();


		// Add to review history
		projectStats.reviewHistory.push({
			date: new Date().toISOString(),
			action: action,
			scoreAfter: scoreAfter
		});

		// Keep only last 100 entries to prevent file from growing too large
		if (projectStats.reviewHistory.length > 100) {
			projectStats.reviewHistory = projectStats.reviewHistory.slice(-100);
		}

		// Increment global stats
		stats.globalStats.totalReviews++;

		await this.saveStatsData();
	}

	// One-time migration: move scores from frontmatter to stats.json
	async migrateScoresToStats() {
		if (this.settings.scoresMigratedToStats) return;

		const projectTagsStr = this.settings.projectTags ?? '';
		const tagsArray = projectTagsStr
			.split(',')
			.map((t: string) => t.trim())
			.filter(Boolean)
			.map((t: string) => (t.startsWith('#') ? t : `#${t}`));

		if (tagsArray.length === 0) {
			// No project tags configured, mark migration as complete
			this.settings.scoresMigratedToStats = true;
			await this.saveSettings();
			return;
		}

		const mdFiles = this.app.vault.getMarkdownFiles();
		let migratedCount = 0;

		for (const file of mdFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;

			// Use unified tag extraction API to include frontmatter and body tags
			const allTags = this.app.metadataCache.getFileCache(file)?.tags?.map(t => t.tag) || [];
			const hasProjectTag = allTags.some((t: string) => tagsArray.includes(t));
			if (!hasProjectTag) continue;

			// Check if project already has stats
			const stats = await this.loadStatsData();
			if (stats.projects[file.path]) continue;

			// Read frontmatter score if it exists
			const fm = (cache as any).frontmatter ?? {};
			let initialScore = this.settings.defaultScore;

			if (typeof fm.pertinence_score !== 'undefined') {
				const frontmatterScore = Number(fm.pertinence_score);
				if (isFinite(frontmatterScore)) {
					// Clamp to [1, 100] range
					initialScore = Math.min(100, Math.max(1, frontmatterScore));
				}
			}

			// Initialize project stats with the score
			stats.projects[file.path] = {
				currentScore: initialScore,
				rotationBonus: 0,
				totalReviews: 0,
				lastReviewDate: '',
				reviewHistory: []
			};

			migratedCount++;
		}

		// Save stats and mark migration as complete
		await this.saveStatsData();
		this.settings.scoresMigratedToStats = true;
		await this.saveSettings();

		if (migratedCount > 0) {
			console.log(`Projects Memory: Migrated ${migratedCount} project scores to stats.json`);
		}
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

// Non-blocking suggest dropdown attached to an input element
class TagsSuggestor extends AbstractInputSuggest<string> {
	private availableTags: string[];
	private plugin: ProjectsMemoryPlugin;

	constructor(app: App, inputEl: HTMLInputElement, availableTags: string[], plugin: ProjectsMemoryPlugin) {
		super(app, inputEl);
		this.availableTags = availableTags;
		this.plugin = plugin;
	}

	private computeMatches(query: string): string[] {
		const tokens = query.split(',');
		const currentToken = tokens[tokens.length - 1].trim();
		if (!currentToken) return [];
		const lower = currentToken.toLowerCase();
		return this.availableTags.filter(t => t.toLowerCase().includes(lower));
	}

	protected getSuggestions(query: string): string[] | Promise<string[]> {
		return this.computeMatches(query);
	}

	renderSuggestion(item: string, el: HTMLElement) {
		el.setText(item);
	}

	selectSuggestion(item: string, _evt: MouseEvent | KeyboardEvent) {
		// Use public accessors for value; access underlying element only to move caret
		const current = this.getValue();
		const parts = current.split(',');
		parts[parts.length - 1] = ' ' + item;
		const newVal = parts.map(p => p.trim()).filter(Boolean).join(', ') + ', ';
		this.setValue(newVal);
		this.plugin.settings.projectTags = newVal.replace(/\s*,\s*$/, '');
		this.plugin.saveSettings();
		// Move caret to end and focus input
		const el = (this as any).inputEl as HTMLInputElement | undefined;
		if (el) {
			el.focus();
			try { el.setSelectionRange(el.value.length, el.value.length); } catch { }
		}
		// Close the suggestion list after selection
		this.close();
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
				const suggestor = new TagsSuggestor(this.app, text.inputEl, availableTags, this.plugin);
				const debouncedOpen = debounce(() => {
					// only open if there's a non-empty current token
					const value = text.getValue();
					const tokens = value.split(',');
					const currentToken = tokens[tokens.length - 1].trim();
					if (!currentToken) return;
					suggestor.open();
				}, 150);

				text.inputEl.addEventListener('input', () => debouncedOpen());
			});

		// Archive tag configuration
		new Setting(containerEl)
			.setName('Archive tag')
			.setDesc('Tag to apply when a project is marked finished (do not include the leading #).')
			.addText(text => {
				text
					.setPlaceholder('projet-fini')
					.setValue(this.plugin.settings.archiveTag)
					.onChange(async (value) => {
						this.plugin.settings.archiveTag = value;
						await this.plugin.saveSettings();
					});
			});

		// New configurable factors for scoring
		new Setting(containerEl)
			.setName('Rotation Bonus')
			.setDesc('Points de bonus ajoutés aux autres projets à chaque review (défaut: 0.1).')
			.addText(text => {
				text
					.setPlaceholder('0.1')
					.setValue(String(this.plugin.settings.rotationBonus))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.rotationBonus = isFinite(n) ? n : 0.1;
						await this.plugin.saveSettings();
					});
			});

		// Rapprochement factor: fraction of remaining gap closed per click
		new Setting(containerEl)
			.setName('Rapprochement factor')
			.setDesc('Fraction of the remaining gap closed on each click (0..1, default: 0.2).')
			.addText(text => {
				text
					.setPlaceholder('0.2')
					.setValue(String(this.plugin.settings.rapprochmentFactor))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.rapprochmentFactor = isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
						await this.plugin.saveSettings();
					});
			});

		// Pomodoro duration (minutes)
		new Setting(containerEl)
			.setName('Pomodoro duration (minutes)')
			.setDesc('Duration in minutes for the Pomodoro timer (default: 25).')
			.addText(text => {
				text
					.setPlaceholder('25')
					.setValue(String(this.plugin.settings.pomodoroDuration))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.pomodoroDuration = isFinite(n) && n > 0 ? Math.floor(n) : 25;
						await this.plugin.saveSettings();
					});
			});

		// Recency penalty weight: multiplier for per-session recency penalty
		new Setting(containerEl)
			.setName('Recency penalty weight')
			.setDesc("Multiplicator for the recency penalty applied during the session. 1.0 is equivalent to a click on 'Less often'. Set to 0 to disable.")
			.addText(text => {
				text
					.setPlaceholder('0.5')
					.setValue(String(this.plugin.settings.recencyPenaltyWeight))
					.onChange(async (value) => {
						// Use same validation approach as rapprochmentFactor: accept finite >= 0, otherwise fallback to default
						const n = Number(value);
						this.plugin.settings.recencyPenaltyWeight = isFinite(n) && n >= 0 ? n : 0.5;
						await this.plugin.saveSettings();
					});
			});
	}
}
