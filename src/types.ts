/**
 * types.ts — Shared TypeScript types & interfaces for Project Memory.
 */

import { Plugin } from 'obsidian';

export interface ReviewHistoryEntry {
	date: string;
	action: string; // "less-often" | "ok" | "more-often" | "finished" | "emergency"
	scoreAfter: number;
}

export interface WorkSessionEntry {
	date: string;
	ratio?: number;
	duration_minutes?: number;
	target_minutes?: number;
	interrupted?: boolean;
}

export interface ProjectStats {
	currentScore: number; // current pertinence score stored in the persistent stats payload
	rotationBonus: number;
	totalReviews: number;
	lastReviewDate: string;
	lastSatisfiedMilestoneDate?: string;
	reviewHistory: ReviewHistoryEntry[];
	recentWorkDates?: (string | WorkSessionEntry)[];
}

export interface GlobalStats {
	totalReviews: number;
	totalPomodoroTime: number; // in minutes
}

export interface StatsData {
	projects: { [filePath: string]: ProjectStats };
	globalStats: GlobalStats;
}

export interface ProjectsMemorySettings {
	projectTags: string;
	archiveTag: string;
	rotationBonus: number; // bonus points added to other projects when one is worked on
	rapprochmentFactor: number; // fraction between 0 and 1
	recencyPenaltyWeight: number; // multiplier for temporary per-session recency penalty
	scoresMigratedToStats: boolean; // migration flag for statistics payload migration
	pomodoroDuration: number; // duration in minutes for Pomodoro
	statsStoredInData: boolean; // migration flag indicating stats are persisted via saveData
	deadlineProperty: string; // frontmatter property key for deadline (default: 'deadline')
	milestoneProperty: string; // frontmatter property key for milestone (default: 'milestone')
}

export interface PersistedPayload {
	settings?: ProjectsMemorySettings;
	stats?: StatsData;
}

export interface MilestoneInfo {
	raw: string;
	targetDate: Date;
	targetDateStr?: string;
	daysRemaining: number;
	urgencyFactor?: number; // P_milestone in [0, 1]
	isOverdue?: boolean;
	isCycleSatisfied?: boolean;
	isRecurring?: boolean;
	intervalWeeks?: number;
	cycleId?: string;
	displayText?: string; // e.g. "🚩 Mercredi (J-2)" or "🚩 Étape (Aujourd'hui)"
	humanReadable?: string;
	error?: string;
}

export interface TemporalBonusResult {
	temporalBonus: number;
	effectiveFactor: number;
	effectiveScore: number;
	daysRemaining?: number;
	milestoneInfo?: MilestoneInfo | null;
}

// Chart and processing types
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
