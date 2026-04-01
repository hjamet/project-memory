/**
 * statsUtils.ts — Shared business logic for project statistics.
 * Used by both StatsModal (full-screen modal) and StatsView (sidebar).
 */

import { App, Plugin, TFile, getAllTags, Notice } from 'obsidian';

// ─── Interfaces ───────────────────────────────────────────────────────────

export interface ChartDataset {
    label: string;
    data: number[];
    borderColor: string;
    backgroundColor: string;
    fill?: boolean;
    tension?: number;
}

export interface ChartData {
    labels: string[];
    datasets: ChartDataset[];
}

export interface DailyActions {
    [date: string]: {
        [projectName: string]: number;
    };
}

export interface ProjectStatEntry {
    name: string;
    path: string;
    timeSpent: number;
    effectiveScore: number;
    totalReviews: number;
    color: string;
}

export interface ProcessedChartData {
    realScoreData: ChartData;
    effectiveScoreData: ChartData;
    dailyActionsData: ChartData;
}

export interface StatsProcessingOptions {
    daysLimit: number;
    projectsLimit: number;
    searchTerm: string;
    selectedProjects: Set<string>;
    plugin: Plugin;
    deadlines: { [path: string]: string };
}

// ─── Pure Utility Functions ───────────────────────────────────────────────

/**
 * Calculate the Levenshtein edit distance between two strings.
 */
export function calculateLevenshteinDistance(a: string, b: string): number {
    if (!a || !b) return (a || b).length;
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,
                matrix[j - 1][i] + 1,
                matrix[j - 1][i - 1] + indicator
            );
        }
    }
    return matrix[b.length][a.length];
}

/**
 * Generate a palette of distinct colors.
 */
export function generateColors(count: number): string[] {
    const palette = [
        '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
        '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6b7280'
    ];
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
        result.push(palette[i % palette.length]);
    }
    return result;
}

/**
 * Format a duration in minutes to a human-readable string.
 */
export function formatTimeSpent(minutes: number): string {
    if (minutes < 60) {
        return `${minutes} min`;
    } else if (minutes < 1440) {
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}min` : `${hours}h`;
    } else {
        const days = Math.floor(minutes / 1440);
        const remainingHours = Math.floor((minutes % 1440) / 60);
        return remainingHours > 0 ? `${days}j ${remainingHours}h` : `${days}j`;
    }
}

/**
 * Calculate the deadline urgency bonus for a project.
 */
export function calculateDeadlineBonus(baseScore: number, currentDate: Date, deadlineStr?: string): number {
    if (!deadlineStr) return 0;

    const deadlineDate = new Date(deadlineStr);
    if (isNaN(deadlineDate.getTime())) return 0;

    const today = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
    const deadlineDay = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());

    const diffTime = deadlineDay.getTime() - today.getTime();
    const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    let factor = 1.0;
    if (daysRemaining > 0) {
        factor = Math.exp(-0.1 * daysRemaining);
    }

    const gap = 100 - baseScore;
    if (gap > 0) {
        return gap * factor;
    }
    return 0;
}

/**
 * Interpolate null/missing values in a numeric array.
 */
export function interpolateMissingValues(data: number[]): void {
    for (let i = 0; i < data.length; i++) {
        if (data[i] === null) {
            let prevValue = null;
            for (let j = i - 1; j >= 0; j--) {
                if (data[j] !== null) { prevValue = data[j]; break; }
            }
            let nextValue = null;
            for (let j = i + 1; j < data.length; j++) {
                if (data[j] !== null) { nextValue = data[j]; break; }
            }
            if (prevValue !== null && nextValue !== null) {
                data[i] = (prevValue + nextValue) / 2;
            } else if (prevValue !== null) {
                data[i] = prevValue;
            } else if (nextValue !== null) {
                data[i] = nextValue;
            } else {
                data[i] = 0;
            }
        }
    }
}

// ─── Plugin-Dependent Functions ──────────────────────────────────────────

/**
 * Filter out archived project paths using the plugin's archive tag setting.
 */
export function filterArchivedProjects(projectPaths: string[], plugin: Plugin): string[] {
    const archiveTag = (plugin as any).settings.archiveTag ?? '';
    const normalizedArchiveTag = archiveTag ? (archiveTag.startsWith('#') ? archiveTag.slice(1) : archiveTag) : '';

    return projectPaths.filter(projectPath => {
        const file = plugin.app.vault.getAbstractFileByPath(projectPath);
        if (!file || !(file instanceof TFile)) return false;

        if (normalizedArchiveTag) {
            const cache = plugin.app.metadataCache.getFileCache(file);
            if (cache) {
                const allTags = getAllTags(cache) || [];
                const hasArchive = allTags.some(t => t.replace(/^#/, '') === normalizedArchiveTag);
                if (hasArchive) return false;
            }
        }
        return true;
    });
}

/**
 * Load deadline values from frontmatter for all markdown files.
 */
export function loadDeadlines(plugin: Plugin): { [path: string]: string } {
    const deadlines: { [path: string]: string } = {};
    plugin.app.vault.getMarkdownFiles().forEach(file => {
        const cache = plugin.app.metadataCache.getFileCache(file);
        const fm = (cache as any)?.frontmatter;
        const deadlineProp = (plugin as any).settings.deadlineProperty || 'deadline';
        if (fm && fm[deadlineProp]) {
            deadlines[file.path] = fm[deadlineProp];
        }
    });
    return deadlines;
}

/**
 * Load stats data from the plugin's persistent storage.
 */
export async function loadStatsData(plugin: Plugin): Promise<any> {
    try {
        return await (plugin as any).loadStatsData();
    } catch (error) {
        console.error('statsUtils: Failed to load stats data:', error);
        return null;
    }
}

/**
 * Load Chart.js and date adapter from CDN. Idempotent (checks if already loaded).
 */
export function loadChartJS(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (typeof (window as any).Chart !== 'undefined') {
            resolve();
            return;
        }

        let scriptsLoaded = 0;
        const totalScripts = 2;
        let hasError = false;

        const checkAllLoaded = () => {
            scriptsLoaded++;
            if (scriptsLoaded === totalScripts && !hasError) {
                let attempts = 0;
                const maxAttempts = 50;
                const checkChart = () => {
                    attempts++;
                    if (typeof (window as any).Chart !== 'undefined') {
                        resolve();
                    } else if (attempts < maxAttempts) {
                        setTimeout(checkChart, 100);
                    } else {
                        console.error('statsUtils: Chart.js failed to initialize after', attempts, 'attempts');
                        reject(new Error('Chart.js failed to initialize on window object'));
                    }
                };
                checkChart();
            }
        };

        const chartScript = document.createElement('script');
        chartScript.src = 'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js';
        chartScript.onload = checkAllLoaded;
        chartScript.onerror = () => {
            hasError = true;
            reject(new Error('Failed to load Chart.js from CDN'));
        };
        document.head.appendChild(chartScript);

        const dateAdapterScript = document.createElement('script');
        dateAdapterScript.src = 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@2.0.0/dist/chartjs-adapter-date-fns.bundle.min.js';
        dateAdapterScript.onload = checkAllLoaded;
        dateAdapterScript.onerror = () => {
            hasError = true;
            reject(new Error('Failed to load Chart.js date adapter from CDN'));
        };
        document.head.appendChild(dateAdapterScript);
    });
}

/**
 * Compute search similarity for a project name against a search term.
 * Returns a similarity score: 2 for substring match, 0..1 for Levenshtein proximity.
 */
export function computeSearchSimilarity(projectName: string, searchTerm: string): number {
    if (!searchTerm.trim()) return 1;

    const searchLower = searchTerm.trim().toLowerCase();
    const projectLower = projectName.toLowerCase();

    if (projectLower.includes(searchLower)) {
        return 2; // Exact substring match gets top priority
    }

    const distance = calculateLevenshteinDistance(projectLower, searchLower);
    const maxLen = Math.max(projectLower.length, searchLower.length);
    return maxLen > 0 ? 1 - (distance / maxLen) : 0;
}

/**
 * Process stats data into chart-ready datasets using the replay mechanism.
 */
export function processStatsData(statsData: any, options: StatsProcessingOptions): ProcessedChartData {
    const { daysLimit, projectsLimit, searchTerm, selectedProjects, plugin, deadlines } = options;

    // Generate date labels
    let dateLabels: string[] = [];
    let dateMap: { [date: string]: number } = {};

    for (let i = daysLimit - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        dateLabels.push(dateStr);
        dateMap[dateStr] = (daysLimit - 1) - i;
    }

    // Filter archived projects
    const allProjectNames = filterArchivedProjects(Object.keys(statsData.projects), plugin);

    if (allProjectNames.length === 0) {
        console.warn('statsUtils: No projects found in stats data');
        throw new Error('No projects found in statistics data');
    }

    // Map projects with scores and search relevance
    const mappedProjects = allProjectNames.map(projectPath => {
        const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
        const score = statsData.projects[projectPath].currentScore + statsData.projects[projectPath].rotationBonus;
        const similarity = computeSearchSimilarity(projectName, searchTerm);
        return { path: projectPath, score, similarity, projectName };
    });

    // Sort
    if (searchTerm.trim()) {
        mappedProjects.sort((a, b) => {
            const tierA = Math.floor(a.similarity * 10);
            const tierB = Math.floor(b.similarity * 10);
            if (tierA !== tierB) return tierB - tierA;
            return b.score - a.score;
        });
    } else {
        mappedProjects.sort((a, b) => b.score - a.score);
    }

    // Apply limit
    let projectNames = mappedProjects.slice(0, projectsLimit).map(p => p.path);

    // Apply selection filter
    if (selectedProjects.size > 0) {
        projectNames = projectNames.filter(path => selectedProjects.has(path));
    }

    const colors = generateColors(projectNames.length);

    // Initialize chart data structures
    const realScoreData: ChartData = { labels: dateLabels, datasets: [] };
    const effectiveScoreData: ChartData = { labels: dateLabels, datasets: [] };
    const dailyActionsData: ChartData = { labels: dateLabels, datasets: [] };

    // --- REPLAY LOGIC ---

    interface ReviewEvent {
        date: Date;
        projectPath: string;
        scoreAfter: number;
    }

    const allEvents: ReviewEvent[] = [];
    Object.keys(statsData.projects).forEach(path => {
        const proj = statsData.projects[path];
        proj.reviewHistory.forEach((r: any) => {
            allEvents.push({ date: new Date(r.date), projectPath: path, scoreAfter: r.scoreAfter });
        });
    });
    allEvents.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Setup replay state
    const projectStates: { [path: string]: { currentScore: number; bonusSnapshot: number } } = {};
    Object.keys(statsData.projects).forEach(p => {
        projectStates[p] = {
            currentScore: (plugin as any).settings.defaultScore || 50,
            bonusSnapshot: 0
        };
    });
    let globalRotationAccumulator = 0;
    const rotationBonusAmount = (plugin as any).settings.rotationBonus || 0.1;

    // Prepare dataset maps
    const realScoreMap: { [path: string]: (number | null)[] } = {};
    const effectiveScoreMap: { [path: string]: (number | null)[] } = {};
    const dailyActionsMap: { [path: string]: number[] } = {};

    projectNames.forEach(p => {
        const len = dateLabels.length;
        realScoreMap[p] = new Array(len).fill(null);
        effectiveScoreMap[p] = new Array(len).fill(null);
        dailyActionsMap[p] = new Array(len).fill(0);
    });

    // Generate time steps
    const timeSteps: Date[] = [];
    if (daysLimit <= 1) {
        for (let i = 23; i >= 0; i--) {
            const d = new Date();
            d.setHours(d.getHours() - i);
            d.setMinutes(59, 59, 999);
            timeSteps.push(d);
        }
    } else {
        for (let i = daysLimit - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            d.setHours(23, 59, 59, 999);
            timeSteps.push(d);
        }
    }

    // Replay events
    let currentEventIdx = 0;
    timeSteps.forEach((stepDate, timeIndex) => {
        while (currentEventIdx < allEvents.length && allEvents[currentEventIdx].date <= stepDate) {
            const event = allEvents[currentEventIdx];

            if (!projectStates[event.projectPath]) {
                projectStates[event.projectPath] = {
                    currentScore: (plugin as any).settings.defaultScore || 50,
                    bonusSnapshot: globalRotationAccumulator
                };
            }

            projectStates[event.projectPath].currentScore = event.scoreAfter;
            projectStates[event.projectPath].bonusSnapshot = globalRotationAccumulator;
            globalRotationAccumulator += rotationBonusAmount;

            // Count daily actions
            if (projectNames.includes(event.projectPath)) {
                let bucketIndex = -1;
                if (daysLimit <= 1) {
                    const h = event.date.getHours().toString().padStart(2, '0') + ':00';
                    if (dateMap[h] !== undefined) bucketIndex = dateMap[h];
                } else {
                    const d = event.date.toISOString().split('T')[0];
                    if (dateMap[d] !== undefined) bucketIndex = dateMap[d];
                }
                if (bucketIndex !== -1 && dailyActionsMap[event.projectPath]) {
                    dailyActionsMap[event.projectPath][bucketIndex]++;
                }
            }

            currentEventIdx++;
        }

        // Snapshot scores
        projectNames.forEach(path => {
            const state = projectStates[path];
            const rotationBonus = globalRotationAccumulator - state.bonusSnapshot;
            const deadline = deadlines[path];
            const deadlineBonus = calculateDeadlineBonus(state.currentScore, stepDate, deadline);
            const effective = state.currentScore + rotationBonus + deadlineBonus;

            effectiveScoreMap[path][timeIndex] = effective;
            realScoreMap[path][timeIndex] = state.currentScore;
        });
    });

    // Build datasets
    projectNames.forEach((projectPath, index) => {
        const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
        const color = colors[index];

        realScoreData.datasets.push({
            label: projectName,
            data: realScoreMap[projectPath] as number[],
            borderColor: color,
            backgroundColor: color + '20',
            fill: false,
            tension: 0.1
        });

        effectiveScoreData.datasets.push({
            label: projectName,
            data: effectiveScoreMap[projectPath] as number[],
            borderColor: color,
            backgroundColor: color + '20',
            fill: false,
            tension: 0.1
        });

        dailyActionsData.datasets.push({
            label: projectName,
            data: dailyActionsMap[projectPath],
            borderColor: color,
            backgroundColor: color + '80'
        });
    });

    if (dailyActionsData.datasets.length === 0) {
        throw new Error('No datasets generated for daily actions chart');
    }

    return { realScoreData, effectiveScoreData, dailyActionsData };
}

/**
 * Calculate stats (time spent, priority, reviews) for each project card.
 */
export function calculateProjectStats(statsData: any, plugin: Plugin): ProjectStatEntry[] {
    const projectNames = filterArchivedProjects(Object.keys(statsData.projects), plugin);
    const colors = generateColors(projectNames.length);

    return projectNames.map((projectPath, index) => {
        const project = statsData.projects[projectPath];
        const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
        const color = colors[index];
        const timeSpent = project.totalReviews * 25;
        const currentScore = project.currentScore || 50;
        const effectiveScore = currentScore + project.rotationBonus;

        return {
            path: projectPath,
            name: projectName,
            timeSpent,
            effectiveScore,
            totalReviews: project.totalReviews,
            color
        };
    });
}

/**
 * Handle the urgent/emergency action for a project.
 */
export async function handleUrgentAction(projectPath: string, plugin: Plugin): Promise<void> {
    try {
        const pluginAny = plugin as any;
        let s = await pluginAny.getProjectScore(projectPath);
        const rapprochment = Number(pluginAny.settings.rapprochementFactor ?? 0.2);
        const gain = rapprochment * (100 - s);
        const newScore = s + gain;

        await pluginAny.updateProjectScore(projectPath, newScore);
        await pluginAny.recordReviewAction(projectPath, 'emergency', newScore, false);

        const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
        new Notice(`Projet "${projectName}" marqué comme urgent !`);
    } catch (error) {
        console.error('statsUtils: Error handling urgent action:', error);
        new Notice('Erreur lors du marquage comme urgent.');
    }
}
