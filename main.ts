import { App, Plugin, PluginSettingTab, Setting, AbstractInputSuggest, TFile, getAllTags } from 'obsidian';
import ReviewModal from './src/ReviewModal';
import StatsModal from './src/StatsModal';
import StatsView, { VIEW_TYPE_STATS } from './src/StatsView';

// Projects Memory plugin: settings and UI for comma-separated project tags

interface ProjectsMemorySettings {
	projectTags: string;
	archiveTag: string;
	rotationBonus: number; // bonus points added to other projects when one is worked on
	rapprochmentFactor: number; // fraction between 0 and 1
	recencyPenaltyWeight: number; // multiplier for temporary per-session recency penalty
	scoresMigratedToStats: boolean; // migration flag for statistics payload migration
	pomodoroDuration: number; // duration in minutes for Pomodoro
	statsStoredInData: boolean; // migration flag indicating stats are persisted via saveData
	deadlineProperty: string; // frontmatter property key for deadline (default: 'deadline')
}

export interface ProjectStats {
	currentScore: number; // current pertinence score stored in the persistent stats payload
	rotationBonus: number;
	totalReviews: number;
	lastReviewDate: string;
	recentWorkDates?: string[]; // ISO UTC timestamps of work sessions in the last 6 hours
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
	archiveTag: 'projet-fini',
	rotationBonus: 0.3,
	rapprochmentFactor: 0.2,
	recencyPenaltyWeight: 0.5,
	scoresMigratedToStats: false,
	pomodoroDuration: 25,
	statsStoredInData: false,
	deadlineProperty: 'deadline'
}

/**
 * Calcule le malus temporel cumulatif multi-sessions sur une fenetre glissante de 6 heures
 * et purge les dates de plus de 6 heures.
 *
 * Formule :
 * Pour chaque t_i dans recentWorkDates tel que delta_t_i = (now - t_i) < 6.0 h :
 *   k_i = 1.0 - (delta_t_i / 6.0)
 *   K = sum(k_i)
 * Malus = K * rf * weight * max(0, baseScore - 1.0)
 */
export function calculateRecencyPenalty(
	recentWorkDates: string[] | undefined,
	baseScore: number,
	rapprochementFactor: number,
	recencyPenaltyWeight: number,
	now: Date = new Date()
): { penalty: number; cleanedDates: string[] } {
	if (!recentWorkDates || recentWorkDates.length === 0 || recencyPenaltyWeight <= 0 || rapprochementFactor <= 0) {
		return { penalty: 0, cleanedDates: [] };
	}
	const sixHoursMs = 6 * 60 * 60 * 1000;
	const nowMs = now.getTime();
	const cleanedDates: string[] = [];
	let K = 0;

	for (const dateStr of recentWorkDates) {
		const d = new Date(dateStr);
		const tMs = d.getTime();
		if (isNaN(tMs)) continue;
		const deltaMs = nowMs - tMs;
		if (deltaMs >= 0 && deltaMs < sixHoursMs) {
			cleanedDates.push(dateStr);
			const deltaHours = deltaMs / (1000 * 60 * 60);
			const ki = 1.0 - (deltaHours / 6.0);
			K += ki;
		}
	}

	const malus = K * rapprochementFactor * recencyPenaltyWeight * Math.max(0, baseScore - 1.0);
	return { penalty: malus, cleanedDates };
}

export default class ProjectsMemoryPlugin extends Plugin {
	settings: ProjectsMemorySettings;
	public lastChosenFile: TFile | null = null;
	// Session-scoped set of ignored project file paths. Resets when plugin reloads.
	public sessionIgnoredProjects: Set<string> = new Set<string>();

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

	// Get project stats (returns null if unreviewed or stats don't exist)
	async getProjectStats(filePath: string): Promise<ProjectStats | null> {
		const stats = await this.loadStatsData();
		const projectStats = stats.projects[filePath];
		if (!projectStats || projectStats.totalReviews === 0 || projectStats.currentScore === undefined || projectStats.currentScore === null) {
			return null;
		}
		return projectStats;
	}

	// Get the current score for a project (returns null if unreviewed or no score recorded)
	async getProjectScore(filePath: string): Promise<number | null> {
		const projectStats = await this.getProjectStats(filePath);
		if (!projectStats) {
			return null;
		}
		return projectStats.currentScore;
	}

	// Update the current score for a project
	async updateProjectScore(filePath: string, newScore: number): Promise<void> {
		const stats = await this.loadStatsData();
		let projectStats = stats.projects[filePath];
		const clampedScore = Math.min(100, Math.max(1, newScore));
		if (!projectStats) {
			projectStats = {
				currentScore: clampedScore,
				rotationBonus: 0,
				totalReviews: 0,
				lastReviewDate: '',
				reviewHistory: []
			};
			stats.projects[filePath] = projectStats;
		} else {
			projectStats.currentScore = clampedScore;
		}

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
				currentScore: scoreAfter,
				rotationBonus: 0,
				totalReviews: 0,
				lastReviewDate: '',
				recentWorkDates: [],
				reviewHistory: []
			};
			stats.projects[filePath] = projectStats;
		}

		if (isReview) {
			projectStats.rotationBonus = 0;
			projectStats.totalReviews++;
			projectStats.lastReviewDate = new Date().toISOString();
			stats.globalStats.totalReviews++;

			// Enregistrement de la session dans recentWorkDates et purge > 6h
			if (!projectStats.recentWorkDates) {
				projectStats.recentWorkDates = [];
			}
			projectStats.recentWorkDates.push(new Date().toISOString());
			const nowMs = Date.now();
			const sixHoursMs = 6 * 60 * 60 * 1000;
			projectStats.recentWorkDates = projectStats.recentWorkDates.filter((dateStr: string) => {
				const t = new Date(dateStr).getTime();
				return !isNaN(t) && (nowMs - t) >= 0 && (nowMs - t) < sixHoursMs;
			});
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
			const isUnreviewed = !projectStats || projectStats.totalReviews === 0 || projectStats.currentScore === undefined || projectStats.currentScore === null;
			let baseScore = isUnreviewed ? 0 : projectStats.currentScore;
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

			// Calcul du malus temporel cumulatif multi-sessions sur 6h
			const weight = Number(this.settings.recencyPenaltyWeight ?? 0.5);
			const rf = Number(this.settings.rapprochmentFactor ?? (this.settings as any).rapprochementFactor ?? 0.2);
			if (isFinite(weight) && weight > 0 && isFinite(rf) && projectStats && projectStats.recentWorkDates && projectStats.recentWorkDates.length > 0) {
				const { penalty, cleanedDates } = calculateRecencyPenalty(
					projectStats.recentWorkDates,
					baseScore,
					rf,
					weight
				);
				projectStats.recentWorkDates = cleanedDates;
				effectiveScore = Math.max(1, effectiveScore - penalty);
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
			let initialScore: number | null = null;

			if (typeof fm.pertinence_score !== 'undefined') {
				const frontmatterScore = Number(fm.pertinence_score);
				if (isFinite(frontmatterScore)) {
					initialScore = Math.min(100, Math.max(1, frontmatterScore));
				}
			}

			if (initialScore !== null) {
				stats.projects[file.path] = {
					currentScore: initialScore,
					rotationBonus: 0,
					totalReviews: 1,
					lastReviewDate: new Date().toISOString(),
					reviewHistory: []
				};
				migratedCount++;
			}
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
			.setDesc('Points de bonus ajoutés aux autres projets à chaque session travaillée (défaut: 0.3).')
			.addText(text => {
				text
					.setPlaceholder('0.3')
					.setValue(String(this.plugin.settings.rotationBonus))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.rotationBonus = isFinite(n) ? n : 0.3;
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
			.setName('Recency penalty weight (Malus temporel 6h)')
			.setDesc('Poids du malus temporel cumulatif décroissant sur 6h pour les projets récemment travaillés (défaut: 0.5). Mettre à 0 pour désactiver.')
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
	}
}
