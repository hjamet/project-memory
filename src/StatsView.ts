/**
 * StatsView.ts — Permanent sidebar view for project statistics.
 * Renders in a narrow portrait layout (~300-400px wide).
 * Shares all business logic with StatsModal via statsUtils.ts.
 */

import { ItemView, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import {
    ProcessedChartData,
    loadChartJS,
    loadStatsData,
    loadDeadlines,
    processStatsData,
    calculateProjectStats,
    computeSearchSimilarity,
    formatTimeSpent,
    handleUrgentAction,
} from './statsUtils';

export const VIEW_TYPE_STATS = 'projects-memory-stats-view';

export default class StatsView extends ItemView {
    plugin: Plugin;
    private chartInstances: any[] = [];
    private deadlines: { [path: string]: string } = {};

    private daysLimit: number = 10;
    private projectsLimit: number = 10;
    private searchTerm: string = '';
    private selectedProjects: Set<string> = new Set<string>();

    constructor(leaf: WorkspaceLeaf, plugin: Plugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_STATS;
    }

    getDisplayText(): string {
        return 'Statistiques Projets';
    }

    getIcon(): string {
        return 'bar-chart-2';
    }

    async onOpen() {
        const rootEl = this.containerEl.children[1] as HTMLElement;
        rootEl.empty();
        rootEl.addClass('projects-memory-stats-view');

        await this.buildUI(rootEl);
    }

    async onClose() {
        this.destroyCharts();
    }

    /**
     * Public refresh method — called externally after a review action.
     */
    public async refresh(): Promise<void> {
        const rootEl = this.containerEl.children[1] as HTMLElement;
        if (!rootEl) return;

        // Save scroll
        const savedScroll = rootEl.scrollTop;

        this.destroyCharts();
        rootEl.empty();

        await this.buildUI(rootEl);

        // Restore scroll
        rootEl.scrollTop = savedScroll;
    }

    // ─── Private Helpers ──────────────────────────────────────────────────

    private destroyCharts(): void {
        this.chartInstances.forEach(chart => {
            if (chart && typeof chart.destroy === 'function') {
                chart.destroy();
            }
        });
        this.chartInstances = [];
    }

    private async buildUI(rootEl: HTMLElement): Promise<void> {
        // Title
        const titleEl = rootEl.createEl('h2', { text: 'Statistiques', cls: 'sv-title' });

        // Search
        this.createSearchBar(rootEl);

        try {
            await loadChartJS();
            this.deadlines = loadDeadlines(this.plugin);

            const statsData = await loadStatsData(this.plugin);

            if (!statsData || Object.keys(statsData.projects).length === 0) {
                rootEl.createEl('p', {
                    text: 'Aucune donnée disponible.',
                    cls: 'sv-no-data'
                });
                return;
            }

            const chartData = this.processData(statsData);

            // Projects list
            this.createProjectsList(statsData, rootEl);

            // Charts
            this.createCharts(chartData, rootEl);

        } catch (error) {
            console.error('StatsView: Error during initialization:', error);
            const errorDiv = rootEl.createEl('div', { cls: 'sv-error' });
            errorDiv.createEl('p', { text: 'Erreur lors du chargement. Vérifiez la console (F12).' });
        }
    }

    private processData(statsData: any): ProcessedChartData {
        return processStatsData(statsData, {
            daysLimit: this.daysLimit,
            projectsLimit: this.projectsLimit,
            searchTerm: this.searchTerm,
            selectedProjects: this.selectedProjects,
            plugin: this.plugin,
            deadlines: this.deadlines
        });
    }

    // ─── Search ───────────────────────────────────────────────────────────

    private createSearchBar(rootEl: HTMLElement): void {
        const searchContainer = rootEl.createEl('div', { cls: 'sv-search-container' });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Rechercher...',
            cls: 'sv-search-input'
        });
        searchInput.value = this.searchTerm;

        searchInput.addEventListener('input', (e) => {
            this.searchTerm = (e.target as HTMLInputElement).value;
            this.refresh();

            setTimeout(() => {
                const newInput = this.containerEl.querySelector('.sv-search-input') as HTMLInputElement;
                if (newInput) {
                    newInput.focus();
                    newInput.setSelectionRange(newInput.value.length, newInput.value.length);
                }
            }, 50);
        });
    }

    // ─── Projects List ────────────────────────────────────────────────────

    private createProjectsList(statsData: any, rootEl: HTMLElement): void {
        if (!statsData || !statsData.projects) return;

        const container = rootEl.createEl('div', { cls: 'sv-projects-container' });

        container.createEl('h3', {
            text: `Projets (Top ${this.projectsLimit})`,
            cls: 'sv-section-title'
        });

        const projectStats = calculateProjectStats(statsData, this.plugin);

        // Map similarity
        const mapped = projectStats.map(p => ({
            ...p,
            similarity: computeSearchSimilarity(p.name, this.searchTerm)
        }));

        // Sort
        if (this.searchTerm.trim()) {
            mapped.sort((a, b) => {
                const tierA = Math.floor(a.similarity * 10);
                const tierB = Math.floor(b.similarity * 10);
                if (tierA !== tierB) return tierB - tierA;
                return b.effectiveScore - a.effectiveScore;
            });
        } else {
            mapped.sort((a, b) => b.effectiveScore - a.effectiveScore);
        }

        const filtered = mapped.slice(0, this.projectsLimit);

        const grid = container.createEl('div', { cls: 'sv-projects-grid' });

        filtered.forEach((project, index) => {
            const isSelected = this.selectedProjects.has(project.path);
            const card = grid.createEl('div', {
                cls: `sv-project-card ${isSelected ? 'is-selected' : ''}`
            });
            card.setAttribute('style', `--project-color: ${project.color}; --project-index: ${index};`);

            // Click for selection
            card.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.sv-urgent-btn') ||
                    (e.target as HTMLElement).closest('.sv-open-btn')) return;

                if (this.selectedProjects.has(project.path)) {
                    this.selectedProjects.delete(project.path);
                } else {
                    this.selectedProjects.add(project.path);
                }
                this.refresh();
            });

            // Card header with name + action buttons
            const cardHeader = card.createEl('div', { cls: 'sv-card-header' });

            cardHeader.createEl('span', { text: project.name, cls: 'sv-project-name' });

            const actions = cardHeader.createEl('div', { cls: 'sv-card-actions' });

            // Urgent button
            const urgentBtn = actions.createEl('span', {
                text: '🚨',
                cls: 'sv-urgent-btn',
                title: 'Urgent'
            });
            urgentBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleUrgentAction(project.path, this.plugin).then(() => this.refresh());
            });

            // Open note button
            const openBtn = actions.createEl('span', {
                text: '📄',
                cls: 'sv-open-btn',
                title: 'Ouvrir la note'
            });
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const file = this.plugin.app.vault.getAbstractFileByPath(project.path);
                if (file instanceof TFile) {
                    const leaf = this.plugin.app.workspace.getLeaf(false);
                    leaf.openFile(file);
                }
            });

            // Stats row
            const statsRow = card.createEl('div', { cls: 'sv-card-stats' });
            statsRow.createEl('span', {
                text: formatTimeSpent(project.timeSpent),
                cls: 'sv-stat-time'
            });
            statsRow.createEl('span', {
                text: `P: ${project.effectiveScore.toFixed(1)}`,
                cls: 'sv-stat-priority'
            });
            statsRow.createEl('span', {
                text: `${project.totalReviews}r`,
                cls: 'sv-stat-reviews'
            });
        });

        // Dynamic controls under projects
        this.createControls(container);
    }

    // ─── Charts ───────────────────────────────────────────────────────────

    private createCharts(chartData: ProcessedChartData, rootEl: HTMLElement): void {
        if (typeof (window as any).Chart === 'undefined') {
            rootEl.createEl('p', { text: 'Chart.js non disponible.', cls: 'sv-error' });
            return;
        }

        const Chart = (window as any).Chart;

        // Effective Score
        const effContainer = rootEl.createEl('div', { cls: 'sv-chart-container' });
        effContainer.createEl('h3', { text: 'Score Effectif', cls: 'sv-section-title' });
        const effCanvas = effContainer.createEl('canvas', { cls: 'sv-chart-canvas' });

        this.chartInstances.push(new Chart(effCanvas, {
            type: 'line',
            data: chartData.effectiveScoreData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        display: true,
                        grid: { display: false },
                        ticks: { maxRotation: 45, font: { size: 9 } }
                    },
                    y: {
                        beginAtZero: false,
                        min: 0,
                        grid: { color: 'rgba(0,0,0,0.06)' },
                        ticks: { font: { size: 10 } }
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: { usePointStyle: true, padding: 8, font: { size: 10 }, boxWidth: 8 }
                    },
                    tooltip: { mode: 'index', intersect: false }
                },
                elements: {
                    point: { radius: 2, hoverRadius: 4 },
                    line: { borderWidth: 1.5 }
                }
            }
        }));

        this.createControls(effContainer);

        // Daily Actions
        const actContainer = rootEl.createEl('div', { cls: 'sv-chart-container' });
        actContainer.createEl('h3', { text: 'Actions / Jour', cls: 'sv-section-title' });
        const actCanvas = actContainer.createEl('canvas', { cls: 'sv-chart-canvas' });

        this.chartInstances.push(new Chart(actCanvas, {
            type: 'bar',
            data: chartData.dailyActionsData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        stacked: true,
                        grid: { display: false },
                        ticks: { maxRotation: 45, font: { size: 9 } }
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        grid: { color: 'rgba(0,0,0,0.06)' },
                        ticks: { font: { size: 10 } }
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: { usePointStyle: true, padding: 8, font: { size: 10 }, boxWidth: 8 }
                    },
                    tooltip: { mode: 'index', intersect: false }
                },
                elements: {
                    bar: { borderWidth: 0 }
                }
            }
        }));

        this.createControls(actContainer);
    }

    // ─── Controls ─────────────────────────────────────────────────────────

    private createControls(container: HTMLElement): void {
        const controlsWrapper = container.createEl('div', { cls: 'sv-controls' });

        // Days
        const daysGroup = controlsWrapper.createEl('div', { cls: 'sv-control-group' });
        const daysMinus = daysGroup.createEl('button', { text: '−', cls: 'sv-ctrl-btn' });
        daysGroup.createEl('span', { text: `${this.daysLimit}j`, cls: 'sv-ctrl-label' });
        const daysPlus = daysGroup.createEl('button', { text: '+', cls: 'sv-ctrl-btn' });

        daysMinus.addEventListener('click', () => {
            if (this.daysLimit > 1) {
                this.daysLimit = Math.max(1, Math.ceil(this.daysLimit / 2));
                this.refresh();
            }
        });
        daysPlus.addEventListener('click', () => {
            this.daysLimit *= 2;
            this.refresh();
        });

        // Projects
        const projGroup = controlsWrapper.createEl('div', { cls: 'sv-control-group' });
        const projMinus = projGroup.createEl('button', { text: '−', cls: 'sv-ctrl-btn' });
        projGroup.createEl('span', { text: `${this.projectsLimit}p`, cls: 'sv-ctrl-label' });
        const projPlus = projGroup.createEl('button', { text: '+', cls: 'sv-ctrl-btn' });

        projMinus.addEventListener('click', () => {
            if (this.projectsLimit > 1) {
                this.projectsLimit = Math.max(1, Math.ceil(this.projectsLimit / 2));
                this.refresh();
            }
        });
        projPlus.addEventListener('click', () => {
            this.projectsLimit *= 2;
            this.refresh();
        });
    }
}
