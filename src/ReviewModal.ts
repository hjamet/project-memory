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
			buttonsRow.setAttr('style', 'display: flex;');
			startPomodoroBtn.setAttr('style', 'display: inline-flex;');
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

	// Calculate urgency color based on score (green -> yellow -> red)
	private getUrgencyColor(score: number): string {
		// Clamp score to [1, 100] range
		const clampedScore = Math.min(100, Math.max(1, score));

		// Convert to 0-1 range
		const normalized = (clampedScore - 1) / 99;

		// Green (low urgency) -> Yellow (medium) -> Red (high urgency)
		if (normalized <= 0.5) {
			// Green to Yellow
			const ratio = normalized * 2;
			const r = Math.round(34 + (255 - 34) * ratio);
			const g = Math.round(139 + (255 - 139) * ratio);
			const b = Math.round(34 + (0 - 34) * ratio);
			return `rgb(${r}, ${g}, ${b})`;
		} else {
			// Yellow to Red
			const ratio = (normalized - 0.5) * 2;
			const r = Math.round(255 + (220 - 255) * ratio);
			const g = Math.round(255 + (20 - 255) * ratio);
			const b = Math.round(0);
			return `rgb(${r}, ${g}, ${b})`;
		}
	}

	// Calculate the effective score for display/selection purposes.
	private async calculateEffectiveScore(baseScore: number, filePath: string, deadline?: string): Promise<number> {
		let effectiveScore = baseScore;

		// Add rotation bonus from stats
		try {
			const pluginAny = this.plugin as any;
			const projectStats = await pluginAny.getProjectStats(filePath);
			effectiveScore += projectStats.rotationBonus;
		} catch (e) {
			// If plugin doesn't expose expected fields, ignore and proceed with base effectiveScore
		}

		// Apply deadline bonus (gap-based)
		// Bonus = (100 - baseScore) * exp(-0.1 * daysRemaining)
		if (deadline) {
			const deadlineDate = new Date(deadline);
			if (!isNaN(deadlineDate.getTime())) {
				const now = new Date();
				// Reset time part to ensure clean day calculation
				const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
				const deadlineDay = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());

				const diffTime = deadlineDay.getTime() - today.getTime();
				const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

				let factor = 1.0;
				if (daysRemaining > 0) {
					factor = Math.exp(-0.1 * daysRemaining);
				}
				// If deadline is today or past, factor stays 1.0 (max urgency)

				const gap = 100 - effectiveScore;
				if (gap > 0) {
					effectiveScore += gap * factor;
				}
			}
		}

		// Apply temporary per-session recency penalty if configured
		try {
			const pluginAny = this.plugin as any;
			const weight = Number(pluginAny.settings?.recencyPenaltyWeight ?? 0.5);
			if (isFinite(weight) && weight > 0 && pluginAny.sessionReviewCounts instanceof Map) {
				const count = pluginAny.sessionReviewCounts.get(filePath) ?? 0;
				if (count > 0) {
					// Allow fractional multipliers by splitting into integer and fractional parts
					const totalMultiplier = count * weight;
					const integerPart = Math.floor(totalMultiplier);
					const fractionalPart = totalMultiplier - integerPart;
					const rapprochment = Number(pluginAny.settings?.rapprochementFactor ?? 0.2);
					for (let i = 0; i < integerPart; i++) {
						// apply same reduction as 'Moins souvent' action: reduce by rapprochment * (s - 1)
						const perte = rapprochment * (effectiveScore - 1);
						effectiveScore = effectiveScore - perte;
					}
					if (fractionalPart > 0) {
						// apply fractional part on the already-reduced score to respect compounded effect
						const finalPerte = rapprochment * (effectiveScore - 1);
						effectiveScore -= finalPerte * fractionalPart;
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
		const candidates: { file: import('obsidian').TFile; effectiveScore: number; baseScore: number, deadline?: string }[] = [];
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
			// Get current score from stats.json
			let baseScore: number;
			try {
				const pluginAny = this.plugin as any;
				baseScore = await pluginAny.getProjectScore(file.path);
			} catch (e) {
				console.error('Failed to get project score:', e);
				baseScore = Number((this.plugin as any).settings.defaultScore ?? 50);
			}

			// Get deadline from frontmatter (if any)
			let deadline: string | undefined;
			try {
				const pluginAny = this.plugin as any;
				const deadlineProp = pluginAny.settings.deadlineProperty || 'deadline';
				const fm = (cache as any).frontmatter;
				if (fm && fm[deadlineProp]) {
					deadline = String(fm[deadlineProp]);
				}
			} catch (e) {
				// ignore invalid deadline
			}

			// calculate effective score using extracted helper to keep logic consistent
			const effectiveScore = await this.calculateEffectiveScore(baseScore, file.path, deadline);
			candidates.push({ file, effectiveScore, baseScore, deadline });
		}

		if (candidates.length === 0) {
			new Notice('No project files found with the configured tags.');
			this.close();
			return;
		}

		// Separate candidates into new projects (totalReviews === 0) and existing projects
		const newProjects: { file: import('obsidian').TFile; effectiveScore: number; baseScore: number, deadline?: string }[] = [];
		const existingProjects: { file: import('obsidian').TFile; effectiveScore: number; baseScore: number, deadline?: string }[] = [];

		for (const candidate of candidates) {
			try {
				const pluginAny = this.plugin as any;
				const projectStats = await pluginAny.getProjectStats(candidate.file.path);
				if (projectStats.totalReviews === 0) {
					newProjects.push(candidate);
				} else {
					existingProjects.push(candidate);
				}
			} catch (e) {
				// If we can't get stats, treat as existing project
				existingProjects.push(candidate);
			}
		}

		// Determine chosen file: prioritize new projects, sorted alphabetically
		// If no new projects, pick from existing projects by highest effectiveScore
		let chosen: { file: import('obsidian').TFile; effectiveScore: number; baseScore: number, deadline?: string };
		if (newProjects.length > 0) {
			// Sort new projects alphabetically by file basename
			newProjects.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
			chosen = newProjects[0];
		} else {
			// Sort existing projects by effectiveScore descending
			existingProjects.sort((a, b) => b.effectiveScore - a.effectiveScore);
			chosen = existingProjects[0];
		}
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

		// Header section
		const headerSection = this.contentEl.createEl('div', { cls: 'pm-review-header' });
		const titleEl = headerSection.createEl('h2', { text: chosen.file.basename });

		// Get project stats early to check if it's a new project
		const projectStats = await (this.plugin as any).getProjectStats(chosen.file.path);

		// Add "Nouveau" badge if this is a new project (totalReviews === 0)
		if (projectStats.totalReviews === 0) {
			titleEl.createEl('span', {
				text: 'Nouveau',
				cls: 'pm-new-indicator'
			});
		}

		// Create badges container
		const badgesContainer = headerSection.createEl('div', { cls: 'pm-badges-container' });

		// Badge 1: Score d'urgence (score de base)
		const urgencyBadge = badgesContainer.createEl('span', {
			text: `${Math.round(chosen.baseScore)}`,
			cls: 'pm-stat-badge pm-badge-urgency'
		});
		// Dynamic color based on score (green -> yellow -> red)
		const urgencyColor = this.getUrgencyColor(chosen.baseScore);
		urgencyBadge.setAttr('style', `background-color: ${urgencyColor};`);

		// Badge 2: Score de session (effectiveScore)
		const sessionBadge = badgesContainer.createEl('span', {
			text: `⚡ ${Math.round(chosen.effectiveScore)}`,
			cls: 'pm-stat-badge pm-badge-session'
		});

		// Badge 3: Temps total (calculé dynamiquement)
		const pomodoroDuration = (this.plugin as any).settings.pomodoroDuration || 25;
		const totalMinutes = projectStats.totalReviews * pomodoroDuration;

		const timeText = totalMinutes >= 60 ?
			`${Math.floor(totalMinutes / 60)}h${totalMinutes % 60 > 0 ? ` ${totalMinutes % 60}m` : ''}` :
			`${totalMinutes}m`;
		const timeBadge = badgesContainer.createEl('span', {
			text: `⏱ ${timeText}`,
			cls: 'pm-stat-badge pm-badge-time'
		});

		// Function to update the time badge
		const updateTimeBadge = async () => {
			const updatedStats = await (this.plugin as any).getProjectStats(chosen.file.path);
			const updatedMinutes = updatedStats.totalReviews * pomodoroDuration;
			const updatedText = updatedMinutes >= 60 ?
				`${Math.floor(updatedMinutes / 60)}h${updatedMinutes % 60 > 0 ? ` ${updatedMinutes % 60}m` : ''}` :
				`${updatedMinutes}m`;
			timeBadge.setText(`⏱ ${updatedText}`);
		};

		const previewContainer = this.contentEl.createEl('div', { cls: 'review-preview' });

		// Create the buttons container early so the UI is present even if markdown rendering fails
		// Pomodoro container (inserted before buttonsRow in DOM flow): button + progress bar
		const pomodoroContainer = this.contentEl.createEl('div', { cls: 'review-pomodoro' });
		const startPomodoroBtn = pomodoroContainer.createEl('button', { cls: 'pm-start-pomodoro' });
		startPomodoroBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Pomodoro</span>';

		// 'Passer' button: temporarily ignore this project for the session and show next
		const skipPomodoroBtn = pomodoroContainer.createEl('button', { cls: 'pm-skip-project pm-skip-secondary' });
		skipPomodoroBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 4 15 12 5 20 5 4"></polyline><line x1="19" y1="5" x2="19" y2="19"></line></svg><span>Passer</span>';

		const progressWrapper = pomodoroContainer.createEl('div', { cls: 'pm-progress-wrapper' });
		progressWrapper.setAttr('style', 'display: none; width: 100%; background: var(--background-modifier-border); height: 6px; border-radius: 3px; overflow: hidden; margin-top: 8px;');
		const progressBar = progressWrapper.createEl('div', { cls: 'pm-progress-bar' });
		progressBar.setAttr('style', 'width: 0%; height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a);');
		// time display and cancel button (initially hidden)
		const timeDisplay = pomodoroContainer.createEl('span', { cls: 'pm-time-display', text: '' });
		timeDisplay.setAttr('style', 'display: none; margin-left: 0.75rem; font-weight: 600;');
		const cancelPomodoroBtn = pomodoroContainer.createEl('button', { cls: 'pm-cancel-pomodoro' });
		cancelPomodoroBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg><span>Annuler</span>';
		cancelPomodoroBtn.setAttr('style', 'display: none; margin-left: 0.5rem;');

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

		// Create the feeling buttons row (Step 1)
		const buttonsRow = this.contentEl.createEl('div', { cls: 'review-buttons' });

		// Step 2: work confirmation overlay (hidden by default)
		const workConfirmOverlay = this.contentEl.createEl('div', { cls: 'pm-work-confirm' });
		workConfirmOverlay.style.display = 'none';

		const workQuestion = workConfirmOverlay.createEl('p', {
			text: 'As-tu travaillé dessus ?',
			cls: 'pm-work-question'
		});

		const workButtonsRow = workConfirmOverlay.createEl('div', { cls: 'pm-work-buttons' });

		const workYesBtn = workButtonsRow.createEl('button', { cls: 'pm-work-yes' });
		workYesBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

		const workNoBtn = workButtonsRow.createEl('button', { cls: 'pm-work-no' });
		workNoBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

		// If a pomodoro is already active at the plugin level, reflect it in this modal's UI
		const pluginAny = this.plugin as any;
		if (pluginAny.pomodoroState && pluginAny.pomodoroState.isActive) {
			this.isPomodoroActive = true;
			// set UI: hide start, show cancel, show time and progress, hide action buttons
			startPomodoroBtn.setAttr('style', 'display: none;');
			cancelPomodoroBtn.setAttr('style', 'display: inline-flex;');
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

		// ---------- Two-step review flow ----------
		// Step 1: feeling buttons (icon-only)
		// Pending state to hold the chosen action between step 1 and step 2
		let pendingAction: { newScore: number; action: string } | null = null;

		// Helper to get the current score
		const getCurrentScore = async (): Promise<number> => {
			try {
				const pluginAny = this.plugin as any;
				return await pluginAny.getProjectScore(chosen.file.path);
			} catch (e) {
				console.error('Failed to get project score:', e);
				return Number((this.plugin as any).settings.defaultScore ?? 50);
			}
		};

		// Helper to perform the actual score update and optional stat recording
		const finalizeReview = async (newScore: number, action: string, workedOnIt: boolean) => {
			// Get project stats to check if this is the first review
			let isFirstReview = false;
			try {
				const pluginAny = this.plugin as any;
				const currentProjectStats = await pluginAny.getProjectStats(chosen.file.path);
				isFirstReview = currentProjectStats.totalReviews === 0;
			} catch (e) {
				console.error('Failed to get project stats:', e);
			}

			// Update score in stats.json
			try {
				const pluginAny = this.plugin as any;
				await pluginAny.updateProjectScore(chosen.file.path, newScore);
			} catch (e) {
				console.error('Failed to update project score:', e);
				return;
			}

			// If this is the first review, only update the score and mark as reviewed
			if (isFirstReview) {
				try {
					const pluginAny = this.plugin as any;
					const stats = await pluginAny.loadStatsData();
					const projectStats = stats.projects[chosen.file.path];
					if (projectStats) {
						projectStats.totalReviews = 1;
						await pluginAny.saveStatsData(stats);
					}
				} catch (e) {
					console.error('Failed to mark project as reviewed:', e);
				}
				return;
			}

			// If the user worked on it → full stat recording (totalReviews++, rotation bonus reset)
			if (workedOnIt) {
				try {
					const pluginAny = this.plugin as any;
					await pluginAny.incrementRotationBonus(chosen.file.path);
					await pluginAny.recordReviewAction(chosen.file.path, action, newScore);
					await updateTimeBadge();
				} catch (e) {
					console.error('Failed to update stats:', e);
				}
			} else {
				// If NOT worked on: record the score adjustment in history without counting as a review
				try {
					const pluginAny = this.plugin as any;
					await pluginAny.recordReviewAction(chosen.file.path, action, newScore, false);
				} catch (e) {
					console.error('Failed to update stats history:', e);
				}
			}
		};

		// Show step 2 (work confirmation)
		const showWorkConfirm = (newScore: number, action: string) => {
			pendingAction = { newScore, action };
			// Hide feeling buttons, show confirmation
			buttonsRow.style.display = 'none';
			workConfirmOverlay.style.display = 'flex';

			// Update keyboard handler for step 2
			if (this.keydownHandler) {
				window.removeEventListener('keydown', this.keydownHandler);
			}
			this.keydownHandler = (e: KeyboardEvent) => {
				if (e.key === 'o' || e.key === 'O' || e.key === 'Enter') {
					workYesBtn.click();
				} else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
					workNoBtn.click();
				}
			};
			window.addEventListener('keydown', this.keydownHandler);
		};

		// Step 1 buttons: feeling selection (icon-only)
		// SVG icons for each feeling
		const sunSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';
		const balanceSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
		const flameSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path></svg>';
		const checkSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';

		const btn1 = buttonsRow.createEl('button', { cls: 'pm-feeling-btn pm-feeling-calm', attr: { 'aria-label': 'Agréable / Calme', 'title': 'Agréable / Calme' } });
		btn1.innerHTML = sunSVG;
		btn1.addEventListener('click', async () => {
			const s = await getCurrentScore();
			const rapprochment = Number((this.plugin as any).settings.rapprochementFactor ?? 0.2);
			const perte = rapprochment * (s - 1);
			// Update session review count
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}
			showWorkConfirm(s - perte, 'less-often');
		});

		const btn2 = buttonsRow.createEl('button', { cls: 'pm-feeling-btn pm-feeling-ok', attr: { 'aria-label': 'Sous contrôle', 'title': 'Sous contrôle' } });
		btn2.innerHTML = balanceSVG;
		btn2.addEventListener('click', async () => {
			const s = await getCurrentScore();
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}
			showWorkConfirm(s, 'ok');
		});

		const btn3 = buttonsRow.createEl('button', { cls: 'pm-feeling-btn pm-feeling-urgent', attr: { 'aria-label': 'Urgent / Stressant', 'title': 'Urgent / Stressant' } });
		btn3.innerHTML = flameSVG;
		btn3.addEventListener('click', async () => {
			const s = await getCurrentScore();
			const rapprochment = Number((this.plugin as any).settings.rapprochementFactor ?? 0.2);
			const gain = rapprochment * (100 - s);
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}
			showWorkConfirm(s + gain, 'more-often');
		});

		const btn5 = buttonsRow.createEl('button', { cls: 'pm-feeling-btn pm-feeling-done', attr: { 'aria-label': 'Fini', 'title': 'Fini' } });
		btn5.innerHTML = checkSVG;
		btn5.addEventListener('click', async () => {
			// Update session review count
			try {
				const pluginAny = this.plugin as any;
				if (!(pluginAny.sessionReviewCounts instanceof Map)) pluginAny.sessionReviewCounts = new Map<string, number>();
				const prev = pluginAny.sessionReviewCounts.get(chosen.file.path) ?? 0;
				pluginAny.sessionReviewCounts.set(chosen.file.path, prev + 1);
			} catch (e) {
				console.error('Failed to update session review counts', e);
			}

			// Check if this is the first review
			let isFirstReview = false;
			try {
				const pluginAny = this.plugin as any;
				const currentProjectStats = await pluginAny.getProjectStats(chosen.file.path);
				isFirstReview = currentProjectStats.totalReviews === 0;
			} catch (e) {
				console.error('Failed to get project stats:', e);
			}

			// If this is the first review, mark as reviewed
			if (isFirstReview) {
				try {
					const pluginAny = this.plugin as any;
					const stats = await pluginAny.loadStatsData();
					const projectStats = stats.projects[chosen.file.path];
					if (projectStats) {
						projectStats.totalReviews = 1;
						await pluginAny.saveStatsData(stats);
					}
				} catch (e) {
					console.error('Failed to mark project as reviewed:', e);
				}
			} else {
				// Record the action in stats
				try {
					const pluginAny = this.plugin as any;
					await pluginAny.incrementRotationBonus(chosen.file.path);
					await pluginAny.recordReviewAction(chosen.file.path, 'finished', 0);
				} catch (e) {
					console.error('Failed to update stats:', e);
				}
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
			this.close();
			setTimeout(() => {
				new (ReviewModal as any)(this.app, this.plugin).open();
			}, 150);
		});

		// Step 2: work confirmation handlers
		workYesBtn.addEventListener('click', async () => {
			if (!pendingAction) return;
			await finalizeReview(pendingAction.newScore, pendingAction.action, true);
			this.close();
			setTimeout(() => {
				new (ReviewModal as any)(this.app, this.plugin).open();
			}, 150);
		});

		workNoBtn.addEventListener('click', async () => {
			if (!pendingAction) return;
			await finalizeReview(pendingAction.newScore, pendingAction.action, false);
			this.close();
			setTimeout(() => {
				new (ReviewModal as any)(this.app, this.plugin).open();
			}, 150);
		});

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
			cancelPomodoroBtn.setAttr('style', 'display: inline-flex;');
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
			buttonsRow.setAttr('style', 'display: flex;');
			startPomodoroBtn.setAttr('style', 'display: inline-flex;');
		});

		// Keyboard shortcuts: 1..4 trigger feeling buttons, 5 for done
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
