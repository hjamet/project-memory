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

	async onOpen() {
		this.contentEl.empty();

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

			// read frontmatter values
			const fm = (cache as any).frontmatter ?? {};
			let baseScore = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			if (!isFinite(baseScore) || baseScore <= 0) baseScore = 1;

			let lastReviewedMillis: number | null = null;
			if (fm.last_reviewed_date) {
				const parsed = Date.parse(String(fm.last_reviewed_date));
				if (!isNaN(parsed)) lastReviewedMillis = parsed;
			}
			if (!lastReviewedMillis) {
				// fall back to file ctime
				lastReviewedMillis = file.stat.ctime;
			}

			const daysSince = Math.floor((now - lastReviewedMillis) / (1000 * 60 * 60 * 24));
			const bonus = daysSince;
			const effectiveScore = baseScore + bonus;
			candidates.push({ file, effectiveScore, baseScore, lastReviewed: fm.last_reviewed_date });
		}

		if (candidates.length === 0) {
			new Notice('No project files found with the configured tags.');
			this.close();
			return;
		}

		// Weighted random selection
		const total = candidates.reduce((s, c) => s + c.effectiveScore, 0);
		let chosen = candidates[0];
		if (total > 0) {
			let r = Math.random() * total;
			for (const c of candidates) {
				r -= c.effectiveScore;
				if (r <= 0) { chosen = c; break; }
			}
		}

		// Build UI
		const titleEl = this.contentEl.createEl('h2', { text: chosen.file.basename });
		const previewContainer = this.contentEl.createEl('div', { cls: 'review-preview' });

		// Create the buttons container early so the UI is present even if markdown rendering fails
		const buttonsRow = this.contentEl.createEl('div', { cls: 'review-buttons' });

		// Read and render file content; guard against rendering errors so buttons still appear
		let fileContent = '';
		try {
			fileContent = await this.app.vault.read(chosen.file);
			// render markdown into preview
			await MarkdownRenderer.render(fileContent, previewContainer, chosen.file.path);
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
			newScore = Math.max(1, newScore);
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
			await updateScore(s / 1.5);
		}, 'pm-moins-souvent');

		const btn2 = makeButton('Fréquence OK', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			await updateScore(s * 1);
		}, 'pm-ok');

		const btn3 = makeButton('Plus souvent', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			await updateScore(s * 1.5);
		}, 'pm-plus-souvent');

		const btn4 = makeButton('Priorité Max', async () => {
			let maxScore = 0;
			for (const f of this.app.vault.getMarkdownFiles()) {
				const c = this.app.metadataCache.getFileCache(f) || {};
				const fm = (c as any).frontmatter ?? {};
				if (typeof fm.pertinence_score !== 'undefined') {
					const val = Number(fm.pertinence_score);
					if (isFinite(val)) maxScore = Math.max(maxScore, val);
				}
			}
			if (maxScore <= 0) maxScore = (this.plugin as any).settings.defaultScore;
			await updateScore(maxScore * 1.2);
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
		this.contentEl.empty();
		if (this.keydownHandler) {
			window.removeEventListener('keydown', this.keydownHandler);
			this.keydownHandler = null;
		}
	}
}
