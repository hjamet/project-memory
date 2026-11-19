/**
 * dashboardUpdater.ts — Met à jour automatiquement le fichier "Project File" (ex. 🎯 Projets.md)
 * à chaque modification de score dans Project Memory, avec des liens Markdown relatifs natifs
 * compatibles Obsidian, SlideFlow et Antigravity (zéro file:///).
 */

import { App, TFile } from 'obsidian';
import { calculateTemporalBonus, isEligibleProject } from './statsUtils';
import { ProjectStats, StatsData } from './types';

const UNREAD_BASELINES_PATH = '_agents/unread_baselines.json';
const ACTIVE_JOBS_FILE_PATH = '_agents/slideflow_active_jobs.json';
const JOBS_BLOCK_START = '<!-- SLIDEFLOW_AGY_JOBS_START -->';
const JOBS_BLOCK_END = '<!-- SLIDEFLOW_AGY_JOBS_END -->';

interface SlideFlowCliJob {
	id: string;
	pid: number | null;
	cli: string;
	model: string;
	status: 'running' | 'done' | 'error';
	startedAt: string;
	finishedAt?: string | null;
	exitCode?: number | null;
	commentCount: number;
	notes: string[];
	errorSummary?: string | null;
}

function isPidAlive(pid: number | null | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return Boolean(err && err.code === 'EPERM');
	}
}

function formatHHMM(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return '--:--';
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatNotesLabel(notes: string[]): string {
	if (!notes || notes.length === 0) return 'Revue SlideFlow';
	const unique = Array.from(new Set(notes.filter(Boolean)));
	if (unique.length === 1) return unique[0];
	return `${unique[0]} (+${unique.length - 1} note${unique.length - 1 > 1 ? 's' : ''})`;
}

async function renderActiveAgyJobsBlock(app: App): Promise<string[]> {
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(ACTIVE_JOBS_FILE_PATH))) return [];
	let jobs: SlideFlowCliJob[] = [];
	try {
		const raw = await adapter.read(ACTIVE_JOBS_FILE_PATH);
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed?.jobs)) {
			jobs = parsed.jobs;
		}
	} catch {
		return [];
	}

	const nowMs = Date.now();
	const kept: SlideFlowCliJob[] = [];
	let changed = false;
	for (const job of jobs) {
		const copy: SlideFlowCliJob = { ...job };
		if (copy.status === 'running' && copy.pid && !isPidAlive(copy.pid)) {
			copy.status = 'error';
			copy.exitCode = copy.exitCode ?? -1;
			copy.errorSummary =
				copy.errorSummary || `PID ${copy.pid} terminé sans code de succès confirmé`;
			copy.finishedAt = copy.finishedAt || new Date(nowMs).toISOString();
			changed = true;
		}
		if (copy.status === 'running') {
			kept.push(copy);
			continue;
		}
		const finTime = new Date(copy.finishedAt || copy.startedAt).getTime();
		const age = isNaN(finTime) ? Infinity : nowMs - finTime;
		const limit = copy.status === 'error' ? 60 * 60 * 1000 : 15 * 60 * 1000;
		if (age <= limit) {
			kept.push(copy);
		} else {
			changed = true;
		}
	}

	if (changed) {
		try {
			await adapter.write(ACTIVE_JOBS_FILE_PATH, JSON.stringify({ version: 1, jobs: kept }, null, 2));
		} catch {
			// non-fatal sync error
		}
	}

	if (kept.length === 0) return [];
	const running = kept.filter((j) => j.status === 'running');
	const recent = kept.filter((j) => j.status !== 'running');
	const lines: string[] = [JOBS_BLOCK_START];

	if (running.length > 0) {
		lines.push(`> 🤖 **Commandes \`agy\` en cours (${running.length})** :`);
		for (const j of running) {
			const label = formatNotesLabel(j.notes);
			const modelPart = j.model ? ` · \`${j.model}\`` : '';
			const pidPart = j.pid ? ` · PID \`${j.pid}\`` : '';
			lines.push(
				`> - ⏳ **${label}** · \`${j.commentCount} commentaire${j.commentCount > 1 ? 's' : ''}\`${modelPart} · démarré à \`${formatHHMM(j.startedAt)}\`${pidPart}`
			);
		}
	} else {
		lines.push(`> 🤖 **Dernières exécutions \`agy\`** :`);
	}

	for (const j of recent) {
		const label = formatNotesLabel(j.notes);
		const modelPart = j.model ? ` · \`${j.model}\`` : '';
		const finStr = formatHHMM(j.finishedAt || j.startedAt);
		if (j.status === 'done') {
			lines.push(
				`> - ✅ **${label}** · \`${j.commentCount} commentaire${j.commentCount > 1 ? 's' : ''}\`${modelPart} · terminé à \`${finStr}\``
			);
		} else {
			const errPart = j.errorSummary ? ` — ${j.errorSummary.slice(0, 120)}` : '';
			lines.push(
				`> - ❌ **${label}** · \`${j.commentCount} commentaire${j.commentCount > 1 ? 's' : ''}\`${modelPart} · échec \`exit ${j.exitCode ?? '?'}\` à \`${finStr}\`${errPart}`
			);
		}
	}

	lines.push(JOBS_BLOCK_END);
	return lines;
}

interface RankedProjectRow {
	file: TFile;
	title: string;
	relPath: string;
	effectiveScore: number | null;
	baseScore: number | null;
	trendArrow: string;
	isModified: boolean;
	deadlineDisp: string;
	milestoneDisp: string;
}

function encodeVaultRelativePath(relPath: string): string {
	return relPath
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.split('/')
		.map((seg) => encodeURIComponent(seg))
		.join('/');
}

function formatLocalTimestamp(d: Date): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	const hh = String(d.getHours()).padStart(2, '0');
	const mi = String(d.getMinutes()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function computeTrendArrow(stats?: ProjectStats): string {
	if (!stats || !Array.isArray(stats.reviewHistory) || stats.reviewHistory.length < 2) {
		return '➖';
	}
	const prev = stats.reviewHistory[stats.reviewHistory.length - 2]?.scoreAfter;
	const curr = stats.reviewHistory[stats.reviewHistory.length - 1]?.scoreAfter;
	if (typeof prev !== 'number' || typeof curr !== 'number') return '➖';
	if (curr > prev + 0.01) return '🟢 ↑';
	if (curr < prev - 0.01) return '🔴 ↓';
	return '➖';
}

async function loadUnreadNotesSet(app: App): Promise<Set<string>> {
	const set = new Set<string>();
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(UNREAD_BASELINES_PATH))) {
		return set;
	}
	const raw = await adapter.read(UNREAD_BASELINES_PATH);
	const parsed = JSON.parse(raw);
	if (parsed && typeof parsed === 'object' && parsed.notes && typeof parsed.notes === 'object') {
		for (const key of Object.keys(parsed.notes)) {
			set.add(key.replace(/\\/g, '/').replace(/^\/+/, ''));
		}
	}
	return set;
}

function extractPreservedQuotaBlock(existingContent: string): string[] {
	const lines = existingContent.replace(/\r\n/g, '\n').split('\n');
	const preserved: string[] = [];
	let capturing = false;
	for (const line of lines) {
		if (!capturing) {
			if (line.startsWith('> ⚡')) {
				capturing = true;
				preserved.push('>');
				preserved.push(line);
			}
		} else {
			if (line.startsWith('>')) {
				preserved.push(line);
			} else {
				break;
			}
		}
	}
	return preserved;
}

export async function updateProjectDashboardFile(plugin: any, statsOverride?: StatsData): Promise<boolean> {
	const rawTarget: string = (plugin.settings?.projectFile || '').trim();
	if (!rawTarget) return false;

	const targetPath = rawTarget.replace(/\\/g, '/').replace(/^\/+/, '');
	const normalizedTarget = targetPath.endsWith('.md') ? targetPath : `${targetPath}.md`;

	const app: App = plugin.app;
	const stats: StatsData = statsOverride ?? (await plugin.loadStatsData());
	const deadlineProp = plugin.settings?.deadlineProperty || 'deadline';
	const milestoneProp = plugin.settings?.milestoneProperty || 'milestone';

	const unreadNotes = await loadUnreadNotesSet(app).catch(() => new Set<string>());
	const mdFiles = app.vault.getMarkdownFiles();
	const now = new Date();

	const newRows: RankedProjectRow[] = [];
	const reviewedRows: RankedProjectRow[] = [];

	for (const file of mdFiles) {
		if (file.path === normalizedTarget) continue;
		const projectStats = stats.projects[file.path];
		if (!isEligibleProject(file.path, plugin, projectStats)) continue;

		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;
		const fm = (cache as any).frontmatter || {};

		let deadlineStr: string | undefined;
		let milestoneStr: string | undefined;
		if (fm[deadlineProp]) deadlineStr = String(fm[deadlineProp]).trim();
		if (fm[milestoneProp]) milestoneStr = String(fm[milestoneProp]).trim();

		const deadlineDisp = deadlineStr ? (deadlineStr.length > 10 ? deadlineStr.slice(0, 10) : deadlineStr) : 'N/A';
		const milestoneDisp = milestoneStr
			? (milestoneStr.length > 15 ? milestoneStr.slice(0, 13) + '..' : milestoneStr)
			: 'N/A';

		const isUnreviewed =
			!projectStats ||
			projectStats.totalReviews === 0 ||
			projectStats.currentScore === undefined ||
			projectStats.currentScore === null;

		const normPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
		const isModified = unreadNotes.has(normPath);

		if (isUnreviewed) {
			newRows.push({
				file,
				title: file.basename,
				relPath: normPath,
				effectiveScore: null,
				baseScore: null,
				trendArrow: '🆕',
				isModified,
				deadlineDisp,
				milestoneDisp,
			});
			continue;
		}

		const baseScore = projectStats.currentScore;
		const rotationBonus = projectStats.rotationBonus || 0;
		const temporalRes = calculateTemporalBonus(
			baseScore,
			rotationBonus,
			deadlineStr,
			milestoneStr,
			projectStats.lastSatisfiedMilestoneDate,
			now
		);

		reviewedRows.push({
			file,
			title: file.basename,
			relPath: normPath,
			effectiveScore: temporalRes.effectiveScore,
			baseScore,
			trendArrow: computeTrendArrow(projectStats),
			isModified,
			deadlineDisp,
			milestoneDisp,
		});
	}

	newRows.sort((a, b) => a.title.localeCompare(b.title));
	reviewedRows.sort(
		(a, b) =>
			((b.effectiveScore ?? -1) - (a.effectiveScore ?? -1)) ||
			((b.baseScore ?? -1) - (a.baseScore ?? -1)) ||
			a.title.localeCompare(b.title)
	);

	const allRows = [...newRows, ...reviewedRows];

	let existingContent = '';
	const existingAbstract = app.vault.getAbstractFileByPath(normalizedTarget);
	if (existingAbstract instanceof TFile) {
		existingContent = await app.vault.read(existingAbstract);
	}
	const quotaLines = extractPreservedQuotaBlock(existingContent);
	const activeJobsLines = await renderActiveAgyJobsBlock(app);

	const out: string[] = [
		'# 🎯 Tableau de Bord des Projets',
		'',
		`> 🔄 **Dernière mise à jour** : ${formatLocalTimestamp(now)} · **Projets actifs** : ${reviewedRows.length} révisés${newRows.length > 0 ? ` · ${newRows.length} nouveaux` : ''}`,
		...quotaLines,
		...(activeJobsLines.length > 0 ? ['', ...activeJobsLines] : []),
		'',
		'| Title | Score | Diff | Deadline | Milestone |',
		'| :--- | :---: | :---: | :---: | :---: |',
	];

	for (const row of allRows) {
		const encodedRel = encodeVaultRelativePath(row.relPath);
		const titleLink = `[${row.title}](${encodedRel})`;
		const scoreStr =
			row.effectiveScore !== null
				? `${row.effectiveScore.toFixed(2)} ${row.trendArrow}`.trim()
				: `NEW ${row.trendArrow}`.trim();
		const diffCell = row.isModified ? '●' : '-';
		out.push(`| ${titleLink} | ${scoreStr} | ${diffCell} | ${row.deadlineDisp} | ${row.milestoneDisp} |`);
	}

	const nextContent = out.join('\n') + '\n';

	if (existingAbstract instanceof TFile) {
		if (existingContent.replace(/\r\n/g, '\n') !== nextContent) {
			await app.vault.modify(existingAbstract, nextContent);
		}
	} else {
		const parentDir = normalizedTarget.includes('/')
			? normalizedTarget.split('/').slice(0, -1).join('/')
			: '';
		if (parentDir && !(await app.vault.adapter.exists(parentDir))) {
			await app.vault.adapter.mkdir(parentDir);
		}
		await app.vault.create(normalizedTarget, nextContent);
	}

	return true;
}
