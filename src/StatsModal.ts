import { App, Modal, Plugin, TFile } from 'obsidian';
import {
    ChartData,
    ProcessedChartData,
    ProjectStatEntry,
    loadChartJS,
    loadStatsData,
    loadDeadlines,
    processStatsData,
    calculateProjectStats,
    computeSearchSimilarity,
    formatTimeSpent,
    handleUrgentAction,
    generateColors,
} from './statsUtils';


export default class StatsModal extends Modal {
    plugin: Plugin;
    chartInstances: any[] = [];
    private deadlines: { [path: string]: string } = {};

    private daysLimit: number = 10;
    private projectsLimit: number = 10;
    private searchTerm: string = '';
    private selectedProjects: Set<string> = new Set<string>();

    constructor(app: App, plugin: Plugin) {
        super(app);
        this.plugin = plugin;
        this.modalEl.classList.add('projects-memory-stats-modal');
    }

    async onOpen() {
        this.contentEl.empty();

        // Create title
        const titleEl = this.contentEl.createEl('h2', { text: 'Statistiques des Projets' });
        titleEl.style.textAlign = 'center';
        titleEl.style.marginBottom = '1rem';

        // Create search container
        this.createSearchContainer();

        try {
            // Load Chart.js from CDN
            await loadChartJS();

            // Load deadlines
            this.deadlines = loadDeadlines(this.plugin);

            // Load and process stats data
            const statsData = await loadStatsData(this.plugin);

            if (!statsData || Object.keys(statsData.projects).length === 0) {
                this.contentEl.createEl('p', {
                    text: 'Aucune donnée statistique disponible. Utilisez le système de review pour générer des données.',
                    cls: 'no-data-message'
                });
                return;
            }

            // Process data for charts
            const chartData = this.processData(statsData);

            // Create chart containers (includes projects list at the top)
            this.createChartContainers(chartData, statsData);

        } catch (error) {
            console.error('StatsModal: Error during initialization:', error);
            const errorDiv = this.contentEl.createEl('div', {
                cls: 'error-message'
            });
            errorDiv.innerHTML = `
                <h3 style="color: #e74c3c; text-align: center;">Erreur lors du chargement des statistiques</h3>
                <p style="text-align: center; color: var(--text-muted);">
                    Impossible de charger les graphiques. Vérifiez la console développeur (F12) pour plus de détails.
                </p>
                <p style="text-align: center; color: var(--text-muted);">
                    Cause probable : Problème de connexion internet ou Chart.js non disponible.
                </p>
            `;
        }
    }

    /**
     * Delegate to the shared processStatsData with this modal's current options.
     */
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

    private createChartContainers(chartData: ProcessedChartData, statsData: any): void {
        // Verify Chart.js is available
        if (typeof (window as any).Chart === 'undefined') {
            const errorMsg = 'Chart.js is not available on window object. Cannot create charts.';
            console.error('StatsModal:', errorMsg);
            throw new Error(errorMsg);
        }

        const Chart = (window as any).Chart;

        const chartsContainer = this.contentEl.createEl('div', { cls: 'stats-charts-container' });

        // Create projects list at the top
        this.createProjectsListInContainer(statsData, chartsContainer);

        // Effective Score Chart
        const effectiveScoreContainer = chartsContainer.createEl('div', { cls: 'chart-container' });
        effectiveScoreContainer.createEl('h3', { text: 'Évolution du Score Effectif', cls: 'chart-title' });
        const effectiveScoreCanvas = effectiveScoreContainer.createEl('canvas', { cls: 'chart-canvas' });

        this.chartInstances.push(new Chart(effectiveScoreCanvas, {
            type: 'line',
            data: chartData.effectiveScoreData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { display: true, grid: { display: false } },
                    y: { beginAtZero: false, min: 0, grid: { color: 'rgba(0, 0, 0, 0.1)' } }
                },
                plugins: {
                    legend: { display: true, position: 'top', labels: { usePointStyle: true, padding: 20 } },
                    tooltip: { mode: 'index', intersect: false }
                },
                elements: {
                    point: { radius: 3, hoverRadius: 6 },
                    line: { borderWidth: 2 }
                }
            }
        }));

        this.createDynamicControls(effectiveScoreContainer);

        // Daily Actions Chart
        const dailyActionsContainer = chartsContainer.createEl('div', { cls: 'chart-container' });
        dailyActionsContainer.createEl('h3', { text: 'Actions par Jour', cls: 'chart-title' });
        const dailyActionsCanvas = dailyActionsContainer.createEl('canvas', { cls: 'chart-canvas' });

        this.chartInstances.push(new Chart(dailyActionsCanvas, {
            type: 'bar',
            data: chartData.dailyActionsData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(0, 0, 0, 0.1)' } }
                },
                plugins: {
                    legend: { display: true, position: 'top', labels: { usePointStyle: true, padding: 20 } },
                    tooltip: { mode: 'index', intersect: false }
                },
                elements: {
                    bar: { borderWidth: 0 }
                }
            }
        }));

        this.createDynamicControls(dailyActionsContainer);
    }

    onClose() {
        this.chartInstances.forEach(chart => {
            if (chart && typeof chart.destroy === 'function') {
                chart.destroy();
            }
        });
        this.chartInstances = [];
        this.contentEl.empty();
    }

    private createSearchContainer(): void {
        const searchContainer = this.contentEl.createEl('div', { cls: 'stats-search-container' });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Rechercher un projet...',
            cls: 'stats-search-input'
        });
        searchInput.value = this.searchTerm;

        searchInput.addEventListener('input', (e) => {
            this.searchTerm = (e.target as HTMLInputElement).value;
            this.refreshCharts();

            setTimeout(() => {
                const newSearchInput = this.contentEl.querySelector('.stats-search-input') as HTMLInputElement;
                if (newSearchInput) {
                    newSearchInput.focus();
                    newSearchInput.setSelectionRange(newSearchInput.value.length, newSearchInput.value.length);
                }
            }, 50);
        });
    }

    private createDynamicControls(container: HTMLElement): void {
        const controlsContainer = container.createEl('div', { cls: 'stats-dynamic-controls' });

        // Days Limit Control
        const daysControl = controlsContainer.createEl('div', { cls: 'control-group' });
        const daysMinus = daysControl.createEl('button', { text: '-', cls: 'control-btn minus-btn' });
        daysControl.createEl('span', { text: `${this.daysLimit} Jours`, cls: 'control-label' });
        const daysPlus = daysControl.createEl('button', { text: '+', cls: 'control-btn plus-btn' });

        daysMinus.addEventListener('click', () => {
            if (this.daysLimit > 1) {
                this.daysLimit = Math.max(1, Math.ceil(this.daysLimit / 2));
                this.refreshCharts();
            }
        });
        daysPlus.addEventListener('click', () => {
            this.daysLimit *= 2;
            this.refreshCharts();
        });

        // Projects Limit Control
        const projectsControl = controlsContainer.createEl('div', { cls: 'control-group' });
        const projMinus = projectsControl.createEl('button', { text: '-', cls: 'control-btn minus-btn' });
        projectsControl.createEl('span', { text: `${this.projectsLimit} Projets`, cls: 'control-label' });
        const projPlus = projectsControl.createEl('button', { text: '+', cls: 'control-btn plus-btn' });

        projMinus.addEventListener('click', () => {
            if (this.projectsLimit > 1) {
                this.projectsLimit = Math.max(1, Math.ceil(this.projectsLimit / 2));
                this.refreshCharts();
            }
        });
        projPlus.addEventListener('click', () => {
            this.projectsLimit *= 2;
            this.refreshCharts();
        });
    }

    private async refreshCharts(): Promise<void> {
        try {
            const statsData = await loadStatsData(this.plugin);
            const chartData = this.processData(statsData);

            // Preserve scroll position
            let scrollParent: HTMLElement = this.contentEl.closest('.modal-content') as HTMLElement || this.contentEl;
            let el: HTMLElement | null = this.contentEl;
            while (el) {
                if (el.scrollTop > 0) { scrollParent = el; break; }
                el = el.parentElement;
            }
            const savedScroll = scrollParent.scrollTop;

            // Destroy old charts
            this.chartInstances.forEach(chart => {
                if (chart && typeof chart.destroy === 'function') {
                    chart.destroy();
                }
            });
            this.chartInstances = [];

            // Render new elements offline
            const tempDiv = document.createElement('div');
            const originalContentEl = this.contentEl;
            (this as any).contentEl = tempDiv;

            try {
                this.createChartContainers(chartData, statsData);
            } finally {
                (this as any).contentEl = originalContentEl;
            }

            const newContainer = tempDiv.firstElementChild as HTMLElement;
            const oldContainer = this.contentEl.querySelector('.stats-charts-container');

            // Blur active element to avoid scroll jump
            if (oldContainer && document.activeElement && oldContainer.contains(document.activeElement)) {
                (document.activeElement as HTMLElement).blur();
            }

            // Seamless DOM swap
            if (oldContainer && newContainer) {
                this.contentEl.replaceChild(newContainer, oldContainer);
            } else if (newContainer) {
                this.contentEl.appendChild(newContainer);
            }

            // Restore scroll
            scrollParent.scrollTop = savedScroll;

        } catch (error) {
            console.error('StatsModal: Error refreshing charts:', error);
        }
    }

    private createProjectsListInContainer(statsData: any, container: HTMLElement): void {
        if (!statsData || !statsData.projects) return;

        const projectsContainer = container.createEl('div', { cls: 'projects-list-container' });

        projectsContainer.createEl('h3', {
            text: `Liste des Projets par Priorité (Max: ${this.projectsLimit})`,
            cls: 'projects-list-title'
        });

        // Calculate project stats using shared logic
        const projectStats = calculateProjectStats(statsData, this.plugin);

        // Map similarity for search
        const mappedProjectStats = projectStats.map(p => {
            const similarity = computeSearchSimilarity(p.name, this.searchTerm);
            return { ...p, similarity };
        });

        // Sort
        if (this.searchTerm.trim()) {
            mappedProjectStats.sort((a, b) => {
                const tierA = Math.floor(a.similarity * 10);
                const tierB = Math.floor(b.similarity * 10);
                if (tierA !== tierB) return tierB - tierA;
                return b.effectiveScore - a.effectiveScore;
            });
        } else {
            mappedProjectStats.sort((a, b) => b.effectiveScore - a.effectiveScore);
        }

        // Apply limits
        const filteredProjectStats = mappedProjectStats.slice(0, this.projectsLimit);

        // Create grid
        const projectsGrid = projectsContainer.createEl('div', { cls: 'projects-grid' });

        filteredProjectStats.forEach((project, index) => {
            const isSelected = this.selectedProjects.has(project.path);
            const projectCard = projectsGrid.createEl('div', {
                cls: `project-card ${isSelected ? 'is-selected' : ''}`
            });
            projectCard.setAttribute('style', `--project-color: ${project.color}; --project-index: ${index};`);

            // Click listener for selection
            projectCard.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.urgent-btn') || (e.target as HTMLElement).closest('.open-note-btn')) return;

                if (this.selectedProjects.has(project.path)) {
                    this.selectedProjects.delete(project.path);
                } else {
                    this.selectedProjects.add(project.path);
                }
                this.refreshCharts();
            });

            // Urgent button
            const urgentBtn = projectCard.createEl('span', {
                text: '🚨',
                cls: 'urgent-btn',
                title: 'Urgent / Stressant'
            });
            urgentBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleUrgentAction(project.path, this.plugin).then(() => this.refreshCharts());
            });

            // Open note button
            const openBtn = projectCard.createEl('span', {
                text: '📄',
                cls: 'open-note-btn',
                title: 'Ouvrir la note'
            });
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const file = this.plugin.app.vault.getAbstractFileByPath(project.path);
                if (file instanceof TFile) {
                    const leaf = this.plugin.app.workspace.getLeaf(false);
                    leaf.openFile(file);
                    this.close();
                }
            });

            // Project info
            projectCard.createEl('div', { text: project.name, cls: 'project-name' });
            projectCard.createEl('div', { text: formatTimeSpent(project.timeSpent), cls: 'project-time' });
            projectCard.createEl('div', { text: `Priorité: ${project.effectiveScore.toFixed(1)}`, cls: 'project-priority' });
            projectCard.createEl('div', { text: `${project.totalReviews} reviews`, cls: 'project-reviews' });
        });

        this.createDynamicControls(projectsContainer);
    }
}
