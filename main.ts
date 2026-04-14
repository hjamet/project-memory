import { App, Plugin, PluginSettingTab, Setting, AbstractInputSuggest, TFile, getAllTags } from 'obsidian';
import ReviewModal from './src/ReviewModal';
import StatsModal from './src/StatsModal';
import StatsView, { VIEW_TYPE_STATS } from './src/StatsView';

// Projects Memory plugin: settings and UI for comma-separated project tags

interface ProjectsMemorySettings {
	projectTags: string;
	defaultScore: number;
	archiveTag: string;
	rotationBonus: number; // bonus points added to other projects when one is worked on
	rapprochmentFactor: number; // fraction between 0 and 1
	recencyPenaltyWeight: number; // multiplier for temporary per-session recency penalty
	scoresMigratedToStats: boolean; // migration flag for statistics payload migration
	pomodoroDuration: number; // duration in minutes for Pomodoro
	statsStoredInData: boolean; // migration flag indicating stats are persisted via saveData
	deadlineProperty: string; // frontmatter property key for deadline (default: 'deadline')
}

interface ProjectStats {
	currentScore: number; // current pertinence score stored in the persistent stats payload
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

interface PersistedPayload {
	settings?: ProjectsMemorySettings;
	stats?: StatsData;
}

function createEmptyStatsData(): StatsData {
	return {
		projects: {},
		globalStats: { totalReviews: 0, totalPomodoroTime: 0 }
	};
}

const DEFAULT_SETTINGS: ProjectsMemorySettings = {
	projectTags: 'projet',
	defaultScore: 100,
	archiveTag: 'projet-fini',
	rotationBonus: 0.1,
	rapprochmentFactor: 0.2,
	recencyPenaltyWeight: 0.5,
	scoresMigratedToStats: false,
	pomodoroDuration: 25,
	statsStoredInData: false,
	deadlineProperty: 'deadline'
}

export default class ProjectsMemoryPlugin extends Plugin {
	settings: ProjectsMemorySettings;
	public lastChosenFile: TFile | null = null;
	// Session-scoped set of ignored project file paths. Resets when plugin reloads.
	public sessionIgnoredProjects: Set<string> = new Set<string>();
	// Session-scoped map of review counts per file path. In-memory only; reset on plugin load.
	public sessionReviewCounts: Map<string, number> = new Map<string, number>();

	public statusBarItemEl: HTMLElement | null = null;
	private lastUrgentProjectName: string = '';
	private lastUrgentProjectTime: number = 0;
	public pomodoroState: any = null;
	public pomodoroGlobalIntervalId: number | null = null;

	private async loadPersistedContainer(): Promise<{ payload: PersistedPayload; isLegacy: boolean }> {
		const raw = await this.loadData();
		if (raw && typeof raw === 'object') {
			if ('settings' in raw || 'stats' in raw) {
				return { payload: { ...(raw as PersistedPayload) }, isLegacy: false };
			}
			return { payload: { settings: raw as ProjectsMemorySettings }, isLegacy: true };
		}
		return { payload: {}, isLegacy: false };
	}

	async onload() {
		await this.loadSettings();
		// Ensure per-session review counts are cleared on each plugin load (do not persist to disk)
		this.sessionReviewCounts.clear();
		await this.migrateStatsToSaveData();
		// Run one-time migration to move scores from frontmatter into the statistics payload
		await this.migrateScoresToStats();

		// Register the stats sidebar view
		this.registerView(VIEW_TYPE_STATS, (leaf) => new StatsView(leaf, this as any));

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

		// Register stats visualization command (full-screen modal)
		this.addCommand({
			id: 'view-stats',
			name: 'View project statistics',
			callback: () => {
				new StatsModal(this.app, this as any).open();
			}
		});

		// Register stats sidebar toggle command
		this.addCommand({
			id: 'toggle-stats-sidebar',
			name: 'Toggle project statistics sidebar',
			callback: () => {
				this.toggleStatsSidebar();
			}
		});

		// Add Status Bar Item
		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.addClass('pm-status-bar');
		this.statusBarItemEl.addEventListener('click', () => {
			new ReviewModal(this.app, this).open();
		});
		this.updateStatusBar();
		this.registerInterval(window.setInterval(() => this.updateStatusBar(), 1000));
		setTimeout(() => this.updateStatusBar(), 2000);

		// Settings tab
		this.addSettingTab(new ProjectsMemorySettingTab(this.app, this));
	}

	onunload() {
		// Detach sidebar leaves to prevent stale references on plugin reload
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_STATS);
	}

	async loadSettings() {
		const { payload, isLegacy } = await this.loadPersistedContainer();
		const storedSettings: Partial<ProjectsMemorySettings> = payload.settings ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings);
		if (!payload.settings || isLegacy) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		const { payload } = await this.loadPersistedContainer();
		const nextPayload: PersistedPayload = {
			...payload,
			settings: this.settings
		};
		await this.saveData(nextPayload);
	}

	// Load stats data from plugin data storage
	async loadStatsData(): Promise<StatsData> {
		const { payload } = await this.loadPersistedContainer();
		if (payload.stats) {
			return payload.stats;
		}
		const initial = createEmptyStatsData();
		await this.saveStatsData(initial);
		return initial;
	}

	// Save stats data to plugin data storage
	async saveStatsData(data: StatsData): Promise<void> {
		const { payload } = await this.loadPersistedContainer();
		const currentSettings = this.settings ?? payload.settings ?? DEFAULT_SETTINGS;
		const nextPayload: PersistedPayload = {
			...payload,
			settings: currentSettings,
			stats: data
		};
		await this.saveData(nextPayload);
	}

	private async migrateStatsToSaveData(): Promise<void> {
		if (this.settings.statsStoredInData) {
			return;
		}

		const { payload } = await this.loadPersistedContainer();
		if (payload.stats) {
			this.settings.statsStoredInData = true;
			await this.saveSettings();
			return;
		}

		const adapter = this.app.vault.adapter;
		const statsPath = `.obsidian/plugins/${this.manifest.id}/stats.json`;
		const legacyStatsExists = await adapter.exists(statsPath);
		if (legacyStatsExists) {
			const rawContent = await adapter.read(statsPath);
			const legacyStats = JSON.parse(rawContent) as StatsData;
			await this.saveStatsData(legacyStats);
			await adapter.remove(statsPath);
		}

		this.settings.statsStoredInData = true;
		await this.saveSettings();
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
			// Persist the created entry
			await this.saveStatsData(stats);
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
		let projectStats = stats.projects[filePath];
		if (!projectStats) {
			projectStats = {
				currentScore: this.settings.defaultScore,
				rotationBonus: 0,
				totalReviews: 0,
				lastReviewDate: '',
				reviewHistory: []
			};
			stats.projects[filePath] = projectStats;
		}

		// Clamp score to [1, 100] range
		projectStats.currentScore = Math.min(100, Math.max(1, newScore));

		await this.saveStatsData(stats);
	}

	// Increment rotation bonus for all projects except the excluded one
	async incrementRotationBonus(excludedPath: string): Promise<void> {
		const stats = await this.loadStatsData();
		const bonusAmount = this.settings.rotationBonus;
		for (const filePath in stats.projects) {
			if (filePath !== excludedPath) {
				stats.projects[filePath].rotationBonus = (stats.projects[filePath].rotationBonus || 0) + bonusAmount;
			}
		}
		await this.saveStatsData(stats);
	}

	// Record a review action for a project
	async recordReviewAction(filePath: string, action: string, scoreAfter: number, isReview = true): Promise<void> {
		const stats = await this.loadStatsData();
		let projectStats = stats.projects[filePath];
		if (!projectStats) {
			projectStats = {
				currentScore: this.settings.defaultScore,
				rotationBonus: 0,
				totalReviews: 0,
				lastReviewDate: '',
				reviewHistory: []
			};
			stats.projects[filePath] = projectStats;
		}

		if (isReview) {
			projectStats.rotationBonus = 0;
			projectStats.totalReviews++;
			projectStats.lastReviewDate = new Date().toISOString();
			stats.globalStats.totalReviews++;
		}

		projectStats.reviewHistory.push({
			date: new Date().toISOString(),
			action: action,
			scoreAfter: scoreAfter
		});

		if (projectStats.reviewHistory.length > 100) {
			projectStats.reviewHistory = projectStats.reviewHistory.slice(-100);
		}

		await this.saveStatsData(stats);

		// Auto-refresh the stats sidebar if it is open
		this.refreshStatsSidebar();
	}

	// Toggle the stats sidebar view (open or close)
	private async toggleStatsSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_STATS);
		if (existing.length > 0) {
			// Close existing sidebar
			existing.forEach(leaf => leaf.detach());
		} else {
			// Open in right sidebar
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_STATS, active: true });
				this.app.workspace.revealLeaf(leaf);
			}
		}
	}

	// Refresh the stats sidebar if open — called after review actions
	private refreshStatsSidebar(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_STATS);
		leaves.forEach(leaf => {
			const view = leaf.view;
			if (view instanceof StatsView) {
				view.refresh();
			}
		});
	}

	private async getMostUrgentProjectName(): Promise<string> {
		const projectTagsStr = this.settings.projectTags ?? '';
		const tagsArray = projectTagsStr
			.split(',')
			.map((t: string) => t.trim())
			.filter(Boolean)
			.map((t: string) => (t.startsWith('#') ? t : `#${t}`));

		if (tagsArray.length === 0) return '';
		const archiveTag = this.settings.archiveTag ?? '';
		const normalizedArchiveTag = archiveTag ? (archiveTag.startsWith('#') ? archiveTag : `#${archiveTag}`) : '';

		const mdFiles = this.app.vault.getMarkdownFiles();
		let topScore = -1;
		let topName = '';

		const stats = await this.loadStatsData();
		const deadlineProp = this.settings.deadlineProperty || 'deadline';

		for (const file of mdFiles) {
			if (this.sessionIgnoredProjects && this.sessionIgnoredProjects.has(file.path)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;

			const allTags = getAllTags(cache) || [];
			const hasProjectTag = allTags.some((t: string) => tagsArray.includes(t));
			if (!hasProjectTag) continue;

			const hasArchiveTag = normalizedArchiveTag ? allTags.includes(normalizedArchiveTag) : false;
			if (hasArchiveTag) continue;

			const projectStats = stats.projects[file.path];
			let baseScore = projectStats ? projectStats.currentScore : this.settings.defaultScore;
			let effectiveScore = baseScore + (projectStats ? projectStats.rotationBonus : 0);

			const fm = (cache as any).frontmatter;
			if (fm && fm[deadlineProp]) {
				const deadline = String(fm[deadlineProp]);
				const deadlineDate = new Date(deadline);
				if (!isNaN(deadlineDate.getTime())) {
					const now = new Date();
					const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
					const deadlineDay = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());
					const diffTime = deadlineDay.getTime() - today.getTime();
					const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
					let factor = 1.0;
					if (daysRemaining > 0) factor = Math.exp(-0.1 * daysRemaining);
					const gap = 100 - effectiveScore;
					if (gap > 0) effectiveScore += gap * factor;
				}
			}

			const weight = Number(this.settings.recencyPenaltyWeight ?? 0.5);
			if (isFinite(weight) && weight > 0 && this.sessionReviewCounts) {
				const count = this.sessionReviewCounts.get(file.path) ?? 0;
				if (count > 0) {
					const totalMultiplier = count * weight;
					const integerPart = Math.floor(totalMultiplier);
					const fractionalPart = totalMultiplier - integerPart;
					const rapprochment = Number(this.settings.rapprochmentFactor ?? 0.2);
					let currentEffective = effectiveScore;
					for (let i = 0; i < integerPart; i++) {
						const perte = rapprochment * (currentEffective - 1);
						currentEffective -= perte;
					}
					if (fractionalPart > 0) {
						const finalPerte = rapprochment * (currentEffective - 1);
						currentEffective -= finalPerte * fractionalPart;
					}
					effectiveScore = currentEffective;
				}
			}

			if (projectStats && projectStats.totalReviews === 0) {
				effectiveScore += 1000;
			} else if (!projectStats) {
				effectiveScore += 1000;
			}

			if (effectiveScore > topScore) {
				topScore = effectiveScore;
				topName = file.basename;
			} else if (effectiveScore === topScore && topName === '') {
				topName = file.basename; // Fallback
			}
		}
		return topName;
	}

	private async updateStatusBar() {
		if (!this.statusBarItemEl) return;

		let pomodoroText = '';
		let pomodoroPct: number | null = null;
		const s = this.pomodoroState;
		if (s && s.isActive) {
			const elapsed = Date.now() - s.startTime;
			const remaining = Math.max(0, s.durationMs - elapsed);
			pomodoroPct = Math.min(100, Math.max(0, (elapsed / s.durationMs) * 100));
			const secs = Math.ceil(remaining / 1000);
			const minutes = Math.floor(secs / 60);
			const seconds = secs % 60;
			pomodoroText = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
		}

		if (Date.now() - this.lastUrgentProjectTime > 10000 || !this.lastUrgentProjectName) {
			this.lastUrgentProjectTime = Date.now();
			this.getMostUrgentProjectName().then(name => {
				this.lastUrgentProjectName = name;
				this.renderStatusBarContent(pomodoroPct, pomodoroText, this.lastUrgentProjectName);
			});
		} else {
			this.renderStatusBarContent(pomodoroPct, pomodoroText, this.lastUrgentProjectName);
		}
	}

	private renderStatusBarContent(pomodoroPct: number | null, pomodoroText: string, projectName: string) {
		if (!this.statusBarItemEl) return;
		this.statusBarItemEl.empty();
		
		if (pomodoroPct !== null) {
			const barContainer = this.statusBarItemEl.createEl('div', { cls: 'pm-status-bar-pomodoro', attr: { title: pomodoroText } });
			barContainer.createEl('div', { cls: 'pm-status-bar-pomodoro-fill' }).style.width = `${pomodoroPct}%`;
		}
		
		const textWrapper = this.statusBarItemEl.createEl('span');
		if (projectName) {
			textWrapper.setText(`🚨 ${projectName}`);
		} else {
			textWrapper.setText(`✅ Aucun projet`);
		}
	}

	// One-time migration: move scores from frontmatter into the statistics payload
	async migrateScoresToStats() {
		if (this.settings.scoresMigratedToStats) return;

		const projectTagsStr = this.settings.projectTags ?? '';
		const tagsArray = projectTagsStr
			.split(',')
			.map((t: string) => t.trim())
			.filter(Boolean)
			.map((t: string) => (t.startsWith('#') ? t : `#${t}`));

		if (tagsArray.length === 0) {
			this.settings.scoresMigratedToStats = true;
			await this.saveSettings();
			return;
		}

		const mdFiles = this.app.vault.getMarkdownFiles();
		let migratedCount = 0;

		const stats = await this.loadStatsData();

		for (const file of mdFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;

			const allTags = this.app.metadataCache.getFileCache(file)?.tags?.map(t => t.tag) || [];
			const hasProjectTag = allTags.some((t: string) => tagsArray.includes(t));
			if (!hasProjectTag) continue;

			if (stats.projects[file.path]) continue;

			const fm = (cache as any).frontmatter ?? {};
			let initialScore = this.settings.defaultScore;

			if (typeof fm.pertinence_score !== 'undefined') {
				const frontmatterScore = Number(fm.pertinence_score);
				if (isFinite(frontmatterScore)) {
					initialScore = Math.min(100, Math.max(1, frontmatterScore));
				}
			}

			stats.projects[file.path] = {
				currentScore: initialScore,
				rotationBonus: 0,
				totalReviews: 0,
				lastReviewDate: '',
				reviewHistory: []
			};

			migratedCount++;
		}

		await this.saveStatsData(stats);
		this.settings.scoresMigratedToStats = true;
		await this.saveSettings();

		if (migratedCount > 0) {
			console.log(`Projects Memory: Migrated ${migratedCount} project scores into the statistics payload`);
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

		// Deadline property configuration
		new Setting(containerEl)
			.setName('Deadline property')
			.setDesc('Frontmatter property used to determine the project deadline (default: deadline).')
			.addText(text => {
				text
					.setPlaceholder('deadline')
					.setValue(this.plugin.settings.deadlineProperty)
					.onChange(async (value) => {
						this.plugin.settings.deadlineProperty = value || 'deadline';
						await this.plugin.saveSettings();
					});
			});

		// Default Score configuration
		new Setting(containerEl)
			.setName('Default Score')
			.setDesc('Score initial pour les nouveaux projets (min: 1, max: 100, défaut: 100).')
			.addText(text => {
				text
					.setPlaceholder('100')
					.setValue(String(this.plugin.settings.defaultScore))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.defaultScore = isFinite(n) ? Math.min(100, Math.max(1, n)) : 100;
						await this.plugin.saveSettings();
					});
			});
	}
}
