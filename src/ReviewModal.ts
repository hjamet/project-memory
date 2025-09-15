import { App, Modal, Setting, Notice, Plugin, MarkdownRenderer } from 'obsidian';

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
			progressWrapper.setAttr('style', 'display: none;');
			progressBar.setAttr('style', 'width: 0%; height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a);');
			timeDisplay.setAttr('style', 'display: none;');
			cancelPomodoroBtn.setAttr('style', 'display: none;');
			buttonsRow.setAttr('style', 'display: block;');
			startPomodoroBtn.setAttr('style', 'display: inline-block;');
			this.isPomodoroActive = false;
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
		const candidates: { file: import('obsidian').TFile; effectiveScore: number; baseScore: number; lastReviewed?: string }[] = [];
		const now = Date.now();
		for (const file of mdFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			if (!cache.tags) continue;
			const hasProjectTag = cache.tags.some((t) => tagsArray.includes(t.tag));
			if (!hasProjectTag) continue;
			// Exclude archived projects: skip if archiveTag is present in file tags or frontmatter
			const archiveTag = (this.plugin as any).settings.archiveTag ?? '';
			const normalizedArchiveTag = archiveTag ? (archiveTag.startsWith('#') ? archiveTag : `#${archiveTag}`) : '';
			const hasArchiveTagInTags = normalizedArchiveTag ? cache.tags.some((t) => t.tag === normalizedArchiveTag) : false;
			const fm = (cache as any).frontmatter ?? {};
			const fmTagsArray: string[] = [];
			if (Array.isArray(fm.tags)) fmTagsArray.push(...fm.tags.map((x: any) => String(x).replace(/^#/, '')));
			else if (typeof fm.tags === 'string') fmTagsArray.push(...String(fm.tags).split(',').map((s: string) => s.trim().replace(/^#/, '')));
			const hasArchiveTagInFrontmatter = archiveTag ? fmTagsArray.includes(archiveTag.replace(/^#/, '')) : false;
			if (hasArchiveTagInTags || hasArchiveTagInFrontmatter) continue;

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

			// use floating days for precision and user-configurable per-day bonus
			const ageDays = (now - lastReviewedMillis) / (1000 * 60 * 60 * 24);
			const ageBonusPerDay = Number((this.plugin as any).settings.ageBonusPerDay ?? 1);
			const bonus = ageDays * ageBonusPerDay;
			const effectiveScore = baseScore + bonus;
			candidates.push({ file, effectiveScore, baseScore, lastReviewed: fm.last_reviewed_date });
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
		const previewContainer = this.contentEl.createEl('div', { cls: 'review-preview' });

		// Create the buttons container early so the UI is present even if markdown rendering fails
		// Pomodoro container (inserted before buttonsRow in DOM flow): button + progress bar
		const pomodoroContainer = this.contentEl.createEl('div', { cls: 'review-pomodoro' });
		const startPomodoroBtn = pomodoroContainer.createEl('button', { text: 'Lancer le Pomodoro', cls: 'pm-start-pomodoro' });
		const progressWrapper = pomodoroContainer.createEl('div', { cls: 'pm-progress-wrapper' });
		progressWrapper.setAttr('style', 'display: none; width: 100%; background: #eee; height: 12px; border-radius: 6px; overflow: hidden; margin-top: 8px;');
		const progressBar = progressWrapper.createEl('div', { cls: 'pm-progress-bar' });
		progressBar.setAttr('style', 'width: 0%; height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a);');
		// time display and cancel button (initially hidden)
		const timeDisplay = pomodoroContainer.createEl('span', { cls: 'pm-time-display', text: '' });
		timeDisplay.setAttr('style', 'display: none; margin-left: 0.75rem; font-weight: 600;');
		const cancelPomodoroBtn = pomodoroContainer.createEl('button', { text: 'Annuler', cls: 'pm-cancel-pomodoro' });
		cancelPomodoroBtn.setAttr('style', 'display: none; margin-left: 0.5rem;');

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
			new Notice(`Updated score: ${Math.round(newScore * 100) / 100}`);
		};

		// Create buttons with classes and keep references for keyboard shortcuts
		const btn1 = makeButton('Moins souvent', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			if (!isFinite(s)) s = Number((this.plugin as any).settings.defaultScore ?? 50);
			const rapprochment = Number((this.plugin as any).settings.rapprochementFactor ?? 0.2);
			const perte = rapprochment * (s - 1);
			await updateScore(s - perte);
		}, 'pm-moins-souvent');

		const btn2 = makeButton('Fréquence OK', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			if (!isFinite(s)) s = Number((this.plugin as any).settings.defaultScore ?? 50);
			await updateScore(s);
		}, 'pm-ok');

		const btn3 = makeButton('Plus souvent', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			if (!isFinite(s)) s = Number((this.plugin as any).settings.defaultScore ?? 50);
			const rapprochment = Number((this.plugin as any).settings.rapprochementFactor ?? 0.2);
			const gain = rapprochment * (100 - s);
			await updateScore(s + gain);
		}, 'pm-plus-souvent');

		const btn4 = makeButton('Priorité Max', async () => {
			await updateScore(100);
		}, 'pm-prio-max');

		const btn5 = makeButton('Fini', async () => {
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
						// play audio even if modal closed
						try {
							// obtain a resource path for the asset; only play if valid string
							const resource = (this.app.vault.adapter as any).getResourcePath
								? (this.app.vault.adapter as any).getResourcePath('assets/ring.wav')
								: null;
							if (typeof resource === 'string' && resource) {
								const audio = new Audio(resource);
								audio.play().catch(() => { /* playback blocked */ });
							}
						} catch (e) {
							console.error('Pomodoro audio failed', e);
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
			progressWrapper.setAttr('style', 'display: none;');
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
