import { App, Modal, Setting, Notice, Plugin, MarkdownRenderer } from 'obsidian';

export default class ReviewModal extends Modal {
	plugin: Plugin;
	constructor(app: App, plugin: Plugin) {
		super(app);
		this.plugin = plugin;
	}

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
		const fileContent = await this.app.vault.read(chosen.file);
		// render markdown into preview
		await MarkdownRenderer.render(fileContent, previewContainer, chosen.file.path, this);

		const buttonsRow = this.contentEl.createEl('div', { cls: 'review-buttons' });

		const makeButton = (label: string, onClick: () => Promise<void>) => {
			const btn = buttonsRow.createEl('button', { text: label });
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

		// "Moins souvent"
		makeButton('Moins souvent', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			await updateScore(s / 1.5);
		});

		// "Fréquence OK"
		makeButton('Fréquence OK', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			await updateScore(s * 1);
		});

		// "Plus souvent"
		makeButton('Plus souvent', async () => {
			const cache = this.app.metadataCache.getFileCache(chosen.file) || {};
			const fm = (cache as any).frontmatter ?? {};
			let s = typeof fm.pertinence_score !== 'undefined' ? Number(fm.pertinence_score) : (this.plugin as any).settings.defaultScore;
			await updateScore(s * 1.5);
		});

		// "Priorité Max"
		makeButton('Priorité Max', async () => {
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
		});

		// "Fini"
		makeButton('Fini', async () => {
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
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
