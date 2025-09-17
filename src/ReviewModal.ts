import { App, Modal, Setting, Notice, Plugin, MarkdownRenderer, getAllTags } from 'obsidian';

export default class ReviewModal extends Modal {
	plugin: Plugin;
	constructor(app: App, plugin: Plugin) {
		super(app);
		this.plugin = plugin;
		// Scope modal styles to avoid leaking into the rest of Obsidian
		this.modalEl.classList.add('projects-memory-review-modal');
	}
	// Keydown handler used for numeric shortcuts while modal is open
	keydownHandler: ((e: KeyboardEvent) => void) | null = null;
	isClosed: boolean = false;
	pomodoroIntervalId: number | null = null;
	isPomodoroActive: boolean = false;

	// Update pomodoro UI elements from plugin-level state.
	private updatePomodoroUI(
		progressWrapper: any,
		progressBar: any,
		timeDisplay: any,
		cancelPomodoroBtn: any,
		startPomodoroBtn: any,
		buttonsRow: any
	): boolean {
		const pluginAny = this.plugin as any;
		const s = pluginAny.pomodoroState;
		if (!s || !s.isActive) {
			// reset UI when finished
			progressWrapper.style.display = 'none';
			progressBar.setAttr('style', 'width: 0%; height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a);');
			timeDisplay.setAttr('style', 'display: none;');
			cancelPomodoroBtn.setAttr('style', 'display: none;');
			buttonsRow.setAttr('style', 'display: block;');
			startPomodoroBtn.setAttr('style', 'display: inline-block;');
			this.isPomodoroActive = false;
			// ensure layout class is removed so container returns to centered state
			try {
				progressWrapper.parentElement?.classList.remove('pomodoro-active');
			} catch (e) {
				// fail-fast policy: do not throw for DOM cleanup; silently ignore
			}
			return false;
		}
		const remaining = s.remainingMs;
		const pct = Math.min(100, ((s.durationMs - remaining) / s.durationMs) * 100);
		progressBar.setAttr('style', `width: ${pct}%; height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a);`);
		const secs = Math.ceil(remaining / 1000);
		const minutes = Math.floor(secs / 60);
		const seconds = secs % 60;
		timeDisplay.setText(`${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`);
		return true;
	}

	// Calculate the effective score for display/selection purposes.
	// Replicates the logic used in onOpen's candidate loop so it can be
	// re-invoked elsewhere (e.g. for up-to-date notifications).
	private calculateEffectiveScore(baseScore: number, lastReviewedMillis: number, filePath: string): number {
		const now = Date.now();
		// use floating days for precision and user-configurable per-day bonus
		const ageDays = (now - lastReviewedMillis) / (1000 * 60 * 60 * 24);
		const ageBonusPerDay = Number((this.plugin as any).settings.ageBonusPerDay ?? 1);
		const bonus = ageDays * ageBonusPerDay;
		let effectiveScore = baseScore + bonus;
		// Apply temporary per-session recency penalty if configured
		try {
			const pluginAny = this.plugin as any;
			const weight = Number(pluginAny.settings?.recencyPenaltyWeight ?? 1.0);
			if (isFinite(weight) && weight > 0 && pluginAny.sessionReviewCounts instanceof Map) {
				const count = pluginAny.sessionReviewCounts.get(filePath) ?? 0;
				if (count > 0) {
					// Number of times to apply the "Moins souvent" penalty: round(count * weight)
					const times = Math.round(count * weight);
					const rapprochment = Number(pluginAny.settings?.rapprochementFactor ?? 0.2);
					for (let i = 0; i < times; i++) {
						// apply same reduction as 'Moins souvent' action: reduce by rapprochment * (s - 1)
						const perte = rapprochment * (effectiveScore - 1);
						effectiveScore = effectiveScore - perte;
					}
				}
			}
		} catch (e) {
			// If plugin doesn't expose expected fields, ignore and proceed with base effectiveScore
		}
		return effectiveScore;
	}

	async onOpen() {
		// Phase 1 - Load data (async) before touching the DOM
		const projectTagsStr = (this.plugin as any).settings.projectTags ?? '';
		const tagsArray = projectTagsStr
			.split(',')
			.map((t: string) => t.trim())
			.filter(Boolean)
			.map((t: string) => (t.startsWith('#') ? t : `#${t}`));

		if (tagsArray.length === 0) {
			new Notice('No project tags configured. Please set them in plugin settings.');
			this.close();
			return;
		}

		const mdFiles = this.app.vault.getMarkdownFiles();

		// Collect candidate project files
		const candidates: { file: import('obsidian').TFile; effectiveScore: number; baseScore: number; lastReviewed?: string; isNew?: boolean }[] = [];
		const now = Date.now();
		for (const file of mdFiles) {
			// Skip files temporarily ignored for this session
			try {
				const pluginAny = this.plugin as any;
				if (pluginAny.sessionIgnoredProjects && pluginAny.sessionIgnoredProjects.has(file.path)) continue;
			} catch (e) {
				// if plugin does not expose the set, proceed normally
			}
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			// Use unified tag extraction API to include frontmatter and body tags
			const allTags = getAllTags(cache) || [];
			// Check for presence of any configured project tag
			const hasProjectTag = allTags.some((t: string) => tagsArray.includes(t));
			if (!hasProjectTag) continue;
			// Exclude archived projects: skip if archiveTag is present in unified tags
			const archiveTag = (this.plugin as any).settings.archiveTag ?? '';
			const normalizedArchiveTag = archiveTag ? (archiveTag.startsWith('#') ? archiveTag : `#${archiveTag}`) : '';
			const hasArchiveTag = normalizedArchiveTag ? allTags.includes(normalizedArchiveTag) : false;
			if (hasArchiveTag) continue;
			const fm = (cache as any).frontmatter ?? {};

			// read frontmatter values
			let baseScore = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			if (!isFinite(baseScore)) baseScore = Number((this.plugin as any).settings.defaultScore ?? 50);
			// Ensure baseScore is within the normalized range [1, 100]
			baseScore = Math.min(100, Math.max(1, baseScore));

			let lastReviewedMillis: number | null = null;
			if (fm.last_reviewed_date) {
				const parsed = Date.parse(String(fm.last_reviewed_date));
				if (!isNaN(parsed)) lastReviewedMillis = parsed;
			}
			if (!lastReviewedMillis) {
				// fall back to file ctime
				lastReviewedMillis = file.stat.ctime;
			}

			// calculate effective score using extracted helper to keep logic consistent
			const effectiveScore = this.calculateEffectiveScore(baseScore, Number(lastReviewedMillis), file.path);
			// Determine if project is "new" (no pertinence_score in frontmatter)
			const isNew = typeof fm.pertinence_score === 'undefined';
			candidates.push({ file, effectiveScore, baseScore, lastReviewed: fm.last_reviewed_date, isNew });
		}

		if (candidates.length === 0) {
			new Notice('No project files found with the configured tags.');
			this.close();
			return;
		}

		// Determine chosen file: pick highest effectiveScore
		const chosen = candidates.reduce((prev, cur) => cur.effectiveScore > prev.effectiveScore ? cur : prev, candidates[0]);
		// Open the chosen file in the currently active editor pane (do not create a new leaf)
		try {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(chosen.file);
			if (this.isClosed) return;
		} catch (err) {
			console.error('ReviewModal: failed to open chosen file in active pane', err);
		}

		// Read file content before creating any DOM nodes
		let fileContent = '';
		try {
			fileContent = await this.app.vault.read(chosen.file);
			if (this.isClosed) return;
		} catch (err) {
			new Notice('Unable to read project file for preview.');
			console.error('ReviewModal: failed to read file', err);
			this.close();
			return;
		}

		// Phase 2 - Build UI synchronously now that data is loaded
		this.contentEl.empty();

		const titleEl = this.contentEl.createEl('h2', { text: chosen.file.basename });
		// If chosen candidate is new (no pertinence_score), show a "Nouveau" badge
		if ((chosen as any).isNew) {
			const badge = titleEl.createEl('span', { text: 'Nouveau', cls: 'pm-new-indicator' });
			badge.setAttr('aria-hidden', 'true');
		}
		const previewContainer = this.contentEl.createEl('div', { cls: 'review-preview' });

		// Create the buttons container early so the UI is present even if markdown rendering fails
		// Pomodoro container (inserted before buttonsRow in DOM flow): button + progress bar
		const pomodoroContainer = this.contentEl.createEl('div', { cls: 'review-pomodoro' });
		const startPomodoroBtn = pomodoroContainer.createEl('button', { text: 'Lancer le Pomodoro', cls: 'pm-start-pomodoro' });
		// 'Passer' button: temporarily ignore this project for the session and show next
		const skipPomodoroBtn = pomodoroContainer.createEl('button', { text: 'Passer', cls: 'pm-skip-project' });
		const progressWrapper = pomodoroContainer.createEl('div', { cls: 'pm-progress-wrapper' });
		progressWrapper.setAttr('style', 'display: none; width: 100%; background: #eee; height: 12px; border-radius: 6px; overflow: hidden; margin-top: 8px;');
		const progressBar = progressWrapper.createEl('div', { cls: 'pm-progress-bar' });
		progressBar.setAttr('style', 'width: 0%; height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a);');
		// time display and cancel button (initially hidden)
		const timeDisplay = pomodoroContainer.createEl('span', { cls: 'pm-time-display', text: '' });
		timeDisplay.setAttr('style', 'display: none; margin-left: 0.75rem; font-weight: 600;');
		const cancelPomodoroBtn = pomodoroContainer.createEl('button', { text: 'Annuler', cls: 'pm-cancel-pomodoro' });
		cancelPomodoroBtn.setAttr('style', 'display: none; margin-left: 0.5rem;');
		// Style adjustment: ensure skip button sits next to start button
		skipPomodoroBtn.setAttr('style', 'margin-left: 0.5rem;');
		skipPomodoroBtn.addEventListener('click', () => {
			try {
				const pluginAny = this.plugin as any;
				if (!pluginAny.sessionIgnoredProjects) pluginAny.sessionIgnoredProjects = new Set<string>();
				pluginAny.sessionIgnoredProjects.add(chosen.file.path);
			} catch (e) {
				console.error('Failed to mark project as skipped for this session', e);
			}
			// Close current modal and reopen next
			this.close();
			setTimeout(() => {
				new (ReviewModal as any)(this.app, this.plugin).open();
			}, 150);
		});

		// Create the buttons container after pomodoro so DOM order is correct
		const buttonsRow = this.contentEl.createEl('div', { cls: 'review-buttons' });

		// If a pomodoro is already active at the plugin level, reflect it in this modal's UI
		const pluginAny = this.plugin as any;
		if (pluginAny.pomodoroState && pluginAny.pomodoroState.isActive) {
			this.isPomodoroActive = true;
			// set UI: hide start, show cancel, show time and progress, hide action buttons
			startPomodoroBtn.setAttr('style', 'display: none;');
			cancelPomodoroBtn.setAttr('style', 'display: inline-block;');
			buttonsRow.setAttr('style', 'display: none;');
			// show progress without destroying other inline styles
			progressWrapper.style.display = 'block';
			timeDisplay.setAttr('style', 'display: inline-block;');

			// add active class to pomodoro container to adjust layout
			pomodoroContainer.classList.add('pomodoro-active');

			// ensure modal-local UI interval updates from plugin state
			if (this.pomodoroIntervalId) {
				window.clearInterval(this.pomodoroIntervalId);
				this.pomodoroIntervalId = null;
			}
			// call once immediately to avoid initial 1s delay
			this.updatePomodoroUI(progressWrapper, progressBar, timeDisplay, cancelPomodoroBtn, startPomodoroBtn, buttonsRow);
			this.pomodoroIntervalId = window.setInterval(() => {
				this.updatePomodoroUI(progressWrapper, progressBar, timeDisplay, cancelPomodoroBtn, startPomodoroBtn, buttonsRow);
			}, 1000);
		}


		// Phase 3 - Render and finalization
		try {
			// IMPORTANT: use the app-first signature: (app, markdown, el, sourcePath, component)
			await MarkdownRenderer.render(this.app, fileContent, previewContainer, chosen.file.path, this as any);
			if (this.isClosed) return;
		} catch (err) {
			new Notice('Unable to render preview — review controls are still available.');
			console.error('ReviewModal: MarkdownRenderer.render failed', err);
		}

		const makeButton = (label: string, onClick: () => Promise<void>, className?: string) => {
			const btn = buttonsRow.createEl('button', { text: label, cls: className });
			btn.addEventListener('click', async () => {
				await onClick();
				this.close();
				// reopen next review instance
				setTimeout(() => {
					new (ReviewModal as any)(this.app, this.plugin).open();
				}, 150);
			});
			return btn;
		};

		// Helper to update frontmatter scores
		const updateScore = async (newScore: number) => {
			// Clamp stored base score to [1,100]
			newScore = Math.min(100, Math.max(1, newScore));
			await (this.app as any).fileManager.processFrontMatter(chosen.file, (fm: any) => {
				fm.pertinence_score = newScore;
				fm.last_reviewed_date = new Date().toISOString();
			});
			// Recalculate effective score for immediate display (do not persist)
			const recalculated = this.calculateEffectiveScore(newScore, Date.now(), chosen.file.path);
			const persistedRounded = Math.round(newScore);
			const sessionRounded = Math.round(recalculated);
			new Notice(`Score : ${persistedRounded} (réel) | ${sessionRounded} (session)`);
		};

		// Create buttons with classes and keep references for keyboard shortcuts
		const btn1 = makeButton('Moins souvent', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			if (!isFinite(s)) s = Number((this.plugin as any).settings.defaultScore ?? 50);
			const rapprochment = Number((this.plugin as any).settings.rapprochementFactor ?? 0.2);
			const perte = rapprochment * (s - 1);
			// Update in-memory session review count for this file (must run before persisting score)
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}
			await updateScore(s - perte);
		}, 'pm-moins-souvent');

		const btn2 = makeButton('Fréquence OK', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			if (!isFinite(s)) s = Number((this.plugin as any).settings.defaultScore ?? 50);
			// Update in-memory session review count for this file (must run before persisting score)
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}
			await updateScore(s);
		}, 'pm-ok');

		const btn3 = makeButton('Plus souvent', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			if (!isFinite(s)) s = Number((this.plugin as any).settings.defaultScore ?? 50);
			const rapprochment = Number((this.plugin as any).settings.rapprochementFactor ?? 0.2);
			const gain = rapprochment * (100 - s);
			// Update in-memory session review count for this file (must run before persisting score)
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}
			await updateScore(s + gain);
		}, 'pm-plus-souvent');

		const btn4 = makeButton('Priorité Max', async () => {
			// Update in-memory session review count for this file (must run before persisting score)
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}
			await updateScore(100);
		}, 'pm-prio-max');

		const btn5 = makeButton('Fini', async () => {
			// Update in-memory session review count for this file (must run before modifying frontmatter)
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}
			// Remove project tags from frontmatter.tags and add archiveTag
			await (this.app as any).fileManager.processFrontMatter(chosen.file, (fm: any) => {
				const projectTagsStr = (this.plugin as any).settings.projectTags ?? '';
				const projectTags = projectTagsStr.split(',').map((t: string) => t.trim()).filter(Boolean).map((t: string) => (t.startsWith('#') ? t.slice(1) : t));
				const archive = (this.plugin as any).settings.archiveTag ?? 'projet-fini';
				let tags: string[] = [];
				if (Array.isArray(fm.tags)) tags = fm.tags.map((x: any) => String(x));
				else if (typeof fm.tags === 'string') tags = String(fm.tags).split(',').map((s: string) => s.trim()).filter(Boolean);
				// remove any project tags
				tags = tags.filter((t: string) => !projectTags.includes(t.replace(/^#/, '')));
				// add archive tag if not present
				if (!tags.includes(archive)) tags.push(archive);
				fm.tags = tags;
			});
			new Notice('Project archived');
		}, 'pm-fini');

		// Pomodoro start handler
		startPomodoroBtn.addEventListener('click', () => {
			const pluginAny = this.plugin as any;
			if (pluginAny.pomodoroState && pluginAny.pomodoroState.isActive) return;
			const durationMinutes = Number((this.plugin as any).settings.pomodoroDuration ?? 25);
			const durationMs = Math.max(1, durationMinutes) * 60 * 1000;
			const startTime = Date.now();
			// set plugin-level state so timer survives modal close
			pluginAny.pomodoroState = {
				isActive: true,
				startTime,
				durationMs,
				remainingMs: durationMs,
			};
			// update modal UI
			this.isPomodoroActive = true;
			startPomodoroBtn.setAttr('style', 'display: none;');
			cancelPomodoroBtn.setAttr('style', 'display: inline-block;');
			buttonsRow.setAttr('style', 'display: none;');
			// show progress without destroying other inline styles
			progressWrapper.style.display = 'block';
			timeDisplay.setAttr('style', 'display: inline-block;');

			// add active class to pomodoro container to adjust layout
			pomodoroContainer.classList.add('pomodoro-active');

			// plugin-global interval: update remainingMs and play audio on completion
			if (!pluginAny.pomodoroGlobalIntervalId) {
				pluginAny.pomodoroGlobalIntervalId = window.setInterval(() => {
					const s = pluginAny.pomodoroState;
					if (!s || !s.isActive) return;
					const elapsed = Date.now() - s.startTime;
					s.remainingMs = Math.max(0, s.durationMs - elapsed);
					if (s.remainingMs <= 0) {
						// complete globally
						window.clearInterval(pluginAny.pomodoroGlobalIntervalId);
						pluginAny.pomodoroGlobalIntervalId = null;
						s.isActive = false;
						// Best-effort: play ring sound if resource is available; do not block on failure
						try {
							const url = (this as any).app.vault.adapter.getResourcePath('assets/ring.wav');
							if (url) {
								const audio = new Audio(url);
								// attempt play and ignore promise rejection (autoplay policies)
								audio.play().catch(() => { });
							}
						} catch (err) {
							// ignore errors from attempting to play audio
						}
						// Desktop notification: replace Notice with standard Web Notification handling
						try {
							if (typeof Notification !== 'undefined') {
								if (Notification.permission === 'granted') {
									new Notification('Pomodoro terminé !');
								} else if (Notification.permission === 'default') {
									Notification.requestPermission().then((perm) => {
										if (perm === 'granted') new Notification('Pomodoro terminé !');
									});
								} else {
									// denied: do nothing
								}
							} else {
								// Fallback environment: show Obsidian notice
								new Notice('Pomodoro terminé !');
							}
						} catch (err) {
							// Ensure notification errors do not break flow
							try { new Notice('Pomodoro terminé !'); } catch (e) { /* ignore */ }
						}
					}
				}, 1000);
			}

			// modal-local UI updater (reads plugin state)
			if (this.pomodoroIntervalId) {
				window.clearInterval(this.pomodoroIntervalId);
				this.pomodoroIntervalId = null;
			}
			// update once immediately so UI shows without waiting 1s
			this.updatePomodoroUI(progressWrapper, progressBar, timeDisplay, cancelPomodoroBtn, startPomodoroBtn, buttonsRow);
			this.pomodoroIntervalId = window.setInterval(() => {
				this.updatePomodoroUI(progressWrapper, progressBar, timeDisplay, cancelPomodoroBtn, startPomodoroBtn, buttonsRow);
			}, 1000);
		});
		// Cancel button logic: stop plugin-global timer and reset UI
		cancelPomodoroBtn.addEventListener('click', () => {
			const pluginAny = this.plugin as any;
			const s = pluginAny.pomodoroState;
			if (!s || !s.isActive) return;
			// stop global timer
			if (pluginAny.pomodoroGlobalIntervalId) {
				window.clearInterval(pluginAny.pomodoroGlobalIntervalId);
				pluginAny.pomodoroGlobalIntervalId = null;
			}
			pluginAny.pomodoroState = null;
			// clear modal-local UI interval
			if (this.pomodoroIntervalId) {
				window.clearInterval(this.pomodoroIntervalId);
				this.pomodoroIntervalId = null;
			}
			this.isPomodoroActive = false;
			// remove active class from pomodoro container
			pomodoroContainer.classList.remove('pomodoro-active');
			// hide pomodoro UI
			progressWrapper.style.display = 'none';
			progressBar.setAttr('style', 'width: 0%; height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a);');
			timeDisplay.setAttr('style', 'display: none;');
			cancelPomodoroBtn.setAttr('style', 'display: none;');
			// show action buttons and start
			buttonsRow.setAttr('style', 'display: block;');
			startPomodoroBtn.setAttr('style', 'display: inline-block;');
		});

		// Keyboard shortcuts: 1..5 trigger corresponding buttons while modal is open
		this.keydownHandler = (e: KeyboardEvent) => {
			const k = e.key;
			switch (k) {
				case '1':
					btn1?.click();
					break;
				case '2':
					btn2?.click();
					break;
				case '3':
					btn3?.click();
					break;
				case '4':
					btn4?.click();
					break;
				case '5':
					btn5?.click();
					break;
			}
		};
		window.addEventListener('keydown', this.keydownHandler);
	}

	onClose() {
		this.isClosed = true;
		this.contentEl.empty();
		// stop any running pomodoro interval
		if (this.pomodoroIntervalId) {
			window.clearInterval(this.pomodoroIntervalId);
			this.pomodoroIntervalId = null;
		}
		if (this.keydownHandler) {
			window.removeEventListener('keydown', this.keydownHandler);
			this.keydownHandler = null;
		}
	}
}
