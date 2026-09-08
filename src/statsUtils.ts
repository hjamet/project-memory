/**
 * statsUtils.ts — Shared business logic for project statistics.
 * Used by both StatsModal (full-screen modal) and StatsView (sidebar).
 */

import { App, Plugin, TFile, getAllTags, Notice } from 'obsidian';

// ─── Interfaces & Types ───────────────────────────────────────────────────

export type {
    ChartDataset,
    ChartData,
    DailyActions,
    ProjectStatEntry,
    ProcessedChartData,
    StatsProcessingOptions,
    MilestoneInfo,
    TemporalBonusResult,
    ProjectStats,
    StatsData,
    ProjectsMemorySettings,
    PersistedPayload
} from './types';

import {
    ChartDataset,
    ChartData,
    DailyActions,
    ProjectStatEntry,
    ProcessedChartData,
    StatsProcessingOptions,
    MilestoneInfo,
    TemporalBonusResult
} from './types';

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
 * Map of day names (French and English, standard and abbreviations) to JavaScript day index (0 = Sunday, 1 = Monday, ...).
 */
export const DAY_NAME_TO_INDEX: { [key: string]: number } = {
    // French (0 = Dimanche, 1 = Lundi, ...)
    'dimanche': 0, 'dimanches': 0, 'dim': 0,
    'lundi': 1, 'lundis': 1, 'lun': 1,
    'mardi': 2, 'mardis': 2, 'mar': 2,
    'mercredi': 3, 'mercredis': 3, 'mer': 3,
    'jeudi': 4, 'jeudis': 4, 'jeu': 4,
    'vendredi': 5, 'vendredis': 5, 'ven': 5,
    'samedi': 6, 'samedis': 6, 'sam': 6,

    // English (0 = Sunday, 1 = Monday, ...)
    'sunday': 0, 'sundays': 0, 'sun': 0,
    'monday': 1, 'mondays': 1, 'mon': 1,
    'tuesday': 2, 'tuesdays': 2, 'tue': 2,
    'wednesday': 3, 'wednesdays': 3, 'wed': 3,
    'thursday': 4, 'thursdays': 4, 'thu': 4,
    'friday': 5, 'fridays': 5, 'fri': 5,
    'saturday': 6, 'saturdays': 6, 'sat': 6,
};

/**
 * Helper to parse a date string into a local midnight Date object (00:00:00).
 */
export function parseDateOnly(dateStr?: string): Date | null {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
        const year = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1;
        const day = parseInt(match[3], 10);
        const d = new Date(year, month, day);
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const DAY_DISPLAY_NAMES: { [key: number]: string } = {
    0: 'Dimanche',
    1: 'Lundi',
    2: 'Mardi',
    3: 'Mercredi',
    4: 'Jeudi',
    5: 'Vendredi',
    6: 'Samedi'
};

const MONTH_NAMES_FR: string[] = [
    'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
    'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'
];

/**
 * Parse a milestone expression into a concrete MilestoneInfo object.
 *
 * Supported formats:
 * - Fixed ISO dates: YYYY-MM-DD, YYYY-MM-DDTHH:mm (e.g. '2026-08-28', '2026-08-28T10:00')
 * - Simple recurring days (FR & EN): 'mercredi', 'wednesday', 'vendredi', 'tous les mercredis', 'every wednesday'
 * - Recurring days with N-week intervals: 'mercredi@N' (e.g. 'mercredi@3' = every 3 Wednesdays), 'wednesday@N'
 *
 * If `lastSatisfiedDate` indicates that the current milestone occurrence is already validated,
 * the target shifts to the subsequent occurrence (T_current + N*7 days).
 */
export function parseMilestoneTarget(
    rawMilestone: string,
    lastSatisfiedDate?: string,
    nowDate: Date = new Date()
): MilestoneInfo | null {
    if (!rawMilestone || typeof rawMilestone !== 'string') return null;
    const trimmed = rawMilestone.trim();
    if (!trimmed) return null;

    const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());

    // 1. Check for fixed ISO date: YYYY-MM-DD or YYYY-MM-DDTHH:mm(:ss)
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (isoMatch) {
        const year = parseInt(isoMatch[1], 10);
        const month = parseInt(isoMatch[2], 10) - 1;
        const day = parseInt(isoMatch[3], 10);
        const hour = isoMatch[4] !== undefined ? parseInt(isoMatch[4], 10) : 23;
        const minute = isoMatch[5] !== undefined ? parseInt(isoMatch[5], 10) : 59;
        const second = isoMatch[6] !== undefined ? parseInt(isoMatch[6], 10) : 59;

        const targetDate = new Date(year, month, day, hour, minute, second);
        if (
            isNaN(targetDate.getTime()) ||
            targetDate.getFullYear() !== year ||
            targetDate.getMonth() !== month ||
            targetDate.getDate() !== day
        ) {
            return null;
        }

        const targetDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
        const diffTime = targetDay.getTime() - today.getTime();
        const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const targetDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

        let isCycleSatisfied = false;
        if (lastSatisfiedDate) {
            const satisfied = parseDateOnly(lastSatisfiedDate);
            if (satisfied && satisfied.getTime() >= targetDay.getTime()) {
                isCycleSatisfied = true;
            }
        }

        const isOverdue = daysRemaining < 0;
        let urgencyFactor = 0.0;
        if (isCycleSatisfied) {
            urgencyFactor = 0.0;
        } else if (isOverdue || daysRemaining <= 0) {
            urgencyFactor = 1.0;
        } else {
            urgencyFactor = Math.exp(-0.3 * daysRemaining);
        }

        const monthName = MONTH_NAMES_FR[month] || String(month + 1);
        let displayText = '';
        if (isCycleSatisfied) {
            displayText = `🚩 Étape ${day} ${monthName} (validée)`;
        } else if (isOverdue) {
            displayText = `🚩 Étape en retard (J+${Math.abs(daysRemaining)})`;
        } else if (daysRemaining === 0) {
            displayText = `🚩 Étape ${day} ${monthName} (Aujourd'hui)`;
        } else {
            displayText = `🚩 Étape ${day} ${monthName} (J-${daysRemaining})`;
        }

        return {
            targetDate,
            targetDateStr,
            isRecurring: false,
            daysRemaining,
            raw: trimmed,
            displayText,
            isOverdue: isOverdue && !isCycleSatisfied,
            isCycleSatisfied,
            urgencyFactor: Math.round(urgencyFactor * 10000) / 10000
        };
    }

    // 2. Check for recurring day syntax
    let cleanStr = trimmed.toLowerCase();

    // Check for @N week interval (e.g. 'mercredi@3', 'every wednesday @ 2')
    let intervalWeeks = 1;
    const atMatch = cleanStr.match(/^(.*?)\s*@\s*(\d+)\s*$/);
    if (atMatch) {
        cleanStr = atMatch[1].trim();
        const parsedN = parseInt(atMatch[2], 10);
        if (!isNaN(parsedN) && parsedN >= 1) {
            intervalWeeks = parsedN;
        } else {
            return null;
        }
    }

    // Strip recurring prefixes (FR: 'tous les', 'tout les', 'toutes les', 'chaque'; EN: 'every', 'each')
    cleanStr = cleanStr.replace(/^(tous\s+les\s+|tout\s+les\s+|toutes\s+les\s+|chaque\s+|every\s+|each\s+)/i, '').trim();

    const targetDayOfWeek = DAY_NAME_TO_INDEX[cleanStr];
    if (targetDayOfWeek === undefined) {
        return null;
    }

    const currentDayOfWeek = today.getDay();
    const dayDiff = (targetDayOfWeek - currentDayOfWeek + 7) % 7;
    const satisfied = lastSatisfiedDate ? parseDateOnly(lastSatisfiedDate) : null;

    let targetDate: Date;
    let isOverdue = false;
    let isCycleSatisfied = false;

    if (dayDiff === 0) {
        // Today is the milestone day
        const todayTarget = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
        if (satisfied && satisfied.getTime() >= today.getTime()) {
            // Already worked today or later -> advance to next occurrence
            isCycleSatisfied = true;
            targetDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + intervalWeeks * 7, 23, 59, 59);
        } else {
            // Due today!
            targetDate = todayTarget;
            isCycleSatisfied = false;
            isOverdue = false;
        }
    } else {
        // dayDiff > 0: target day is in the future this week, but check if the PREVIOUS occurrence was satisfied
        const tPrev = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (7 - dayDiff), 23, 59, 59);
        const tPrevDay = new Date(tPrev.getFullYear(), tPrev.getMonth(), tPrev.getDate());

        if (!satisfied || satisfied.getTime() < tPrevDay.getTime()) {
            // Previous milestone was NOT satisfied! OVERDUE!
            targetDate = tPrev;
            isOverdue = true;
            isCycleSatisfied = false;
        } else {
            // Previous milestone was satisfied -> advance to next upcoming occurrence
            let tCurr = new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayDiff, 23, 59, 59);
            while (satisfied && satisfied.getTime() >= new Date(tCurr.getFullYear(), tCurr.getMonth(), tCurr.getDate()).getTime()) {
                isCycleSatisfied = true;
                tCurr = new Date(tCurr.getFullYear(), tCurr.getMonth(), tCurr.getDate() + intervalWeeks * 7, 23, 59, 59);
            }
            targetDate = tCurr;
        }
    }

    const targetDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const diffTime = targetDay.getTime() - today.getTime();
    const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const targetDateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;

    let urgencyFactor = 0.0;
    if (isCycleSatisfied) {
        urgencyFactor = 0.0;
    } else if (isOverdue || daysRemaining <= 0) {
        urgencyFactor = 1.0;
    } else {
        urgencyFactor = Math.exp(-0.3 * daysRemaining);
    }

    const dayName = DAY_DISPLAY_NAMES[targetDayOfWeek] || cleanStr;
    let displayText = '';
    if (isCycleSatisfied) {
        displayText = `🚩 ${dayName} (validé)`;
    } else if (isOverdue) {
        displayText = `🚩 ${dayName} en retard (J+${Math.abs(daysRemaining)})`;
    } else if (daysRemaining === 0) {
        displayText = `🚩 ${dayName} (Aujourd'hui)`;
    } else {
        displayText = `🚩 ${dayName} (J-${daysRemaining})`;
    }

    return {
        targetDate,
        targetDateStr,
        isRecurring: true,
        intervalWeeks,
        daysRemaining,
        raw: trimmed,
        displayText,
        isOverdue,
        isCycleSatisfied,
        urgencyFactor: Math.round(urgencyFactor * 10000) / 10000
    };
}

/**
 * Calculate combined non-cumulative temporal pressure bonus from deadline and/or milestone.
 *
 * P_deadline = exp(-0.1 * dt_deadline) (if dt > 0, 1.0 if dt <= 0)
 * P_milestone = exp(-0.3 * dt_milestone) (if dt > 0, 1.0 if dt <= 0)
 * P_eff = max(P_deadline, P_milestone)
 * temporalBonus = max(0, 100 - (baseScore + rotationBonus)) * P_eff
 */
export function calculateTemporalBonus(
    baseScore: number,
    rotationBonus: number,
    deadlineStr?: string,
    milestoneRaw?: string,
    lastSatisfiedDate?: string,
    currentDate: Date = new Date()
): TemporalBonusResult {
    let pDeadline = 0;
    let dtDeadline: number | undefined = undefined;

    if (deadlineStr && typeof deadlineStr === 'string' && deadlineStr.trim()) {
        const deadlineDate = parseDateOnly(deadlineStr);
        if (deadlineDate && !isNaN(deadlineDate.getTime())) {
            const today = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
            const diffTime = deadlineDate.getTime() - today.getTime();
            dtDeadline = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (dtDeadline <= 0) {
                pDeadline = 1.0;
            } else {
                pDeadline = Math.exp(-0.1 * dtDeadline);
            }
        }
    }

    let pMilestone = 0;
    let dtMilestone: number | undefined = undefined;
    let milestoneInfo: MilestoneInfo | null = null;

    if (milestoneRaw && typeof milestoneRaw === 'string' && milestoneRaw.trim()) {
        milestoneInfo = parseMilestoneTarget(milestoneRaw, lastSatisfiedDate, currentDate);
        if (milestoneInfo) {
            dtMilestone = milestoneInfo.daysRemaining;
            pMilestone = milestoneInfo.urgencyFactor !== undefined ? milestoneInfo.urgencyFactor : (dtMilestone <= 0 ? 1.0 : Math.exp(-0.3 * dtMilestone));
        }
    }

    const effectiveFactor = Math.max(pDeadline, pMilestone);

    let daysRemaining: number | undefined = undefined;
    if (pMilestone > 0 || pDeadline > 0) {
        if (pMilestone >= pDeadline && dtMilestone !== undefined) {
            daysRemaining = dtMilestone;
        } else if (dtDeadline !== undefined) {
            daysRemaining = dtDeadline;
        } else {
            daysRemaining = dtMilestone;
        }
    }

    const scoreGap = Math.max(0, 100 - (baseScore + rotationBonus));
    const temporalBonus = scoreGap * effectiveFactor;
    const effectiveScore = Math.min(100, baseScore + rotationBonus + temporalBonus);

    return {
        temporalBonus,
        effectiveFactor,
        effectiveScore,
        daysRemaining,
        milestoneInfo
    };
}

/**
 * Calculate the deadline urgency bonus for a project.
 * (Preserved for backward compatibility, delegates to calculateTemporalBonus logic)
 */
export function calculateDeadlineBonus(baseScore: number, currentDate: Date, deadlineStr?: string): number {
    if (!deadlineStr) return 0;
    const result = calculateTemporalBonus(baseScore, 0, deadlineStr, undefined, undefined, currentDate);
    return result.temporalBonus;
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
            currentScore: statsData.projects[p]?.currentScore ?? 0,
            bonusSnapshot: 0
        };
    });
    let globalRotationAccumulator = 0;
    const rotationBonusAmount = (plugin as any).settings.rotationBonus || 0.3;

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
                    currentScore: event.scoreAfter,
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

    const pluginAny = plugin as any;
    const weight = Number(pluginAny?.settings?.recencyPenaltyWeight ?? 0.5);
    const rf = Number(pluginAny?.settings?.rapprochementFactor ?? pluginAny?.settings?.rapprochmentFactor ?? 0.2);
    const nowMs = Date.now();
    const sixHoursMs = 6 * 60 * 60 * 1000;

    return projectNames.map((projectPath, index) => {
        const project = statsData.projects[projectPath];
        const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
        const color = colors[index];
        const pomodoroDuration = pluginAny?.settings?.pomodoroDuration || 25;
        const timeSpent = (project.totalReviews || 0) * pomodoroDuration;
        const currentScore = project.currentScore ?? 0;
        let effectiveScore = currentScore + (project.rotationBonus || 0);

        // Malus temporel cumulatif 6h
        if (isFinite(weight) && weight > 0 && isFinite(rf) && project.recentWorkDates && Array.isArray(project.recentWorkDates) && project.recentWorkDates.length > 0) {
            let K = 0;
            for (const item of project.recentWorkDates) {
                const dateStr = typeof item === 'string' ? item : (item && typeof item === 'object' && 'date' in item ? String(item.date) : '');
                let ratio = 1.0;
                if (typeof item === 'object' && item !== null) {
                    if ('ratio' in item && typeof item.ratio === 'number') ratio = item.ratio;
                    else if ('weight' in item && typeof item.weight === 'number') ratio = item.weight;
                }
                const d = new Date(dateStr);
                const t = d.getTime();
                if (isNaN(t)) continue;
                const deltaMs = nowMs - t;
                if (deltaMs >= -180000 && deltaMs < sixHoursMs) {
                    const deltaHours = Math.max(0, deltaMs / (1000 * 60 * 60));
                    const ki = (isFinite(ratio) ? ratio : 1.0) * (1.0 - (deltaHours / 6.0));
                    K += ki;
                }
            }
            const malus = K * rf * weight * Math.max(0, currentScore - 1.0);
            effectiveScore = Math.max(1, effectiveScore - malus);
        }

        return {
            path: projectPath,
            name: projectName,
            timeSpent,
            effectiveScore,
            baseScore: currentScore,
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
        const rapprochment = Number(pluginAny.settings?.rapprochementFactor ?? pluginAny.settings?.rapprochmentFactor ?? 0.2);
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
