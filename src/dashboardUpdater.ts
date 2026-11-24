/**
 * dashboardUpdater.ts — Met à jour automatiquement le fichier "Project File" (ex. 🎯 Projets.md)
 * à chaque modification de score dans Project Memory, avec des liens Markdown relatifs natifs
 * compatibles Obsidian, SlideFlow et Antigravity (zéro file:///).
 *
 * Note : les commandes `agy` et les indicateurs de quotas IA (Antigravity Gemini, Antigravity
 * Claude, Claude Code Opus) vivent exclusivement dans la sidebar SlideFlow AGY.
 */

import { App, TFile } from 'obsidian';
import { calculateTemporalBonus, isEligibleProject } from './statsUtils';
import { ProjectStats, StatsData } from './types';

interface RankedProjectRow {
	file: TFile;
	title: string;
	relPath: string;
	effectiveScore: number | null;
	baseScore: number | null;
	trendArrow: string;
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

export async function updateProjectDashboardFile(plugin: any, statsOverride?: StatsData): Promise<boolean> {
	const rawTarget: string = (plugin.settings?.projectFile || '').trim();
	if (!rawTarget) return false;

	const targetPath = rawTarget.replace(/\\/g, '/').replace(/^\/+/, '');
	const normalizedTarget = targetPath.endsWith('.md') ? targetPath : `${targetPath}.md`;

	const app: App = plugin.app;
	const stats: StatsData = statsOverride ?? (await plugin.loadStatsData());
	const deadlineProp = plugin.settings?.deadlineProperty || 'deadline';
	const milestoneProp = plugin.settings?.milestoneProperty || 'milestone';

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

		if (isUnreviewed) {
			newRows.push({
				file,
				title: file.basename,
				relPath: normPath,
				effectiveScore: null,
				baseScore: null,
				trendArrow: '🆕',
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

	const out: string[] = [
		'# 🎯 Tableau de Bord des Projets',
		'',
		`> 🔄 **Dernière mise à jour** : ${formatLocalTimestamp(now)} · **Projets actifs** : ${reviewedRows.length} révisés${newRows.length > 0 ? ` · ${newRows.length} nouveaux` : ''}`,
		'',
		'| Title | Score | Deadline | Milestone |',
		'| :--- | :---: | :---: | :---: |',
	];

	for (const row of allRows) {
		const encodedRel = encodeVaultRelativePath(row.relPath);
		const titleLink = `[${row.title}](${encodedRel})`;
		const scoreStr =
			row.effectiveScore !== null
				? `${row.effectiveScore.toFixed(2)} ${row.trendArrow}`.trim()
				: `NEW ${row.trendArrow}`.trim();
		out.push(`| ${titleLink} | ${scoreStr} | ${row.deadlineDisp} | ${row.milestoneDisp} |`);
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
