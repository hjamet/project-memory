import { App, Modal, Plugin } from 'obsidian';


interface ChartData {
    labels: string[];
    datasets: Array<{
        label: string;
        data: number[];
        borderColor: string;
        backgroundColor: string;
        fill?: boolean;
        tension?: number;
    }>;
}

interface DailyActions {
    [date: string]: {
        [projectName: string]: number;
    };
}

export default class StatsModal extends Modal {
    plugin: Plugin;
    chartInstances: any[] = [];
    private deadlines: { [path: string]: string } = {};

    private daysLimit: number = 10;
    private projectsLimit: number = 10;
    private searchTerm: string = '';

    private calculateLevenshteinDistance(a: string, b: string): number {
        if (!a || !b) return (a || b).length;
        const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
        for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
        for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
        for (let j = 1; j <= b.length; j++) {
            for (let i = 1; i <= a.length; i++) {
                const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(
                    matrix[j][i - 1] + 1, // insertion
                    matrix[j - 1][i] + 1, // deletion
                    matrix[j - 1][i - 1] + indicator // substitution
                );
            }
        }
        return matrix[b.length][a.length];
    }
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
            await this.loadChartJS();

            // Load deadlines
            this.deadlines = {};
            this.plugin.app.vault.getMarkdownFiles().forEach(file => {
                const cache = this.plugin.app.metadataCache.getFileCache(file);
                const fm = (cache as any)?.frontmatter;
                const deadlineProp = (this.plugin as any).settings.deadlineProperty || 'deadline';
                if (fm && fm[deadlineProp]) {
                    this.deadlines[file.path] = fm[deadlineProp];
                }
            });

            // Load and process stats data
            const statsData = await this.loadStatsData();

            if (!statsData || Object.keys(statsData.projects).length === 0) {
                this.contentEl.createEl('p', {
                    text: 'Aucune donnée statistique disponible. Utilisez le système de review pour générer des données.',
                    cls: 'no-data-message'
                });
                return;
            }

            // Process data for charts
            const chartData = this.processStatsData(statsData);

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

    private async loadChartJS(): Promise<void> {
        return new Promise((resolve, reject) => {
            // Check if Chart.js is already loaded
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
                    // Wait a bit for Chart.js to initialize on window object
                    let attempts = 0;
                    const maxAttempts = 50; // 5 seconds max
                    const checkChart = () => {
                        attempts++;
                        if (typeof (window as any).Chart !== 'undefined') {
                            resolve();
                        } else if (attempts < maxAttempts) {
                            setTimeout(checkChart, 100);
                        } else {
                            console.error('StatsModal: Chart.js failed to initialize on window object after', attempts, 'attempts');
                            reject(new Error('Chart.js failed to initialize on window object'));
                        }
                    };
                    checkChart();
                }
            };

            // Load Chart.js
            const chartScript = document.createElement('script');
            chartScript.src = 'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js';
            chartScript.onload = checkAllLoaded;
            chartScript.onerror = () => {
                console.error('StatsModal: Failed to load Chart.js script from CDN');
                hasError = true;
                reject(new Error('Failed to load Chart.js from CDN'));
            };
            document.head.appendChild(chartScript);

            // Load date adapter
            const dateAdapterScript = document.createElement('script');
            dateAdapterScript.src = 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@2.0.0/dist/chartjs-adapter-date-fns.bundle.min.js';
            dateAdapterScript.onload = checkAllLoaded;
            dateAdapterScript.onerror = () => {
                console.error('StatsModal: Failed to load Chart.js date adapter from CDN');
                hasError = true;
                reject(new Error('Failed to load Chart.js date adapter from CDN'));
            };
            document.head.appendChild(dateAdapterScript);
        });
    }

    private async loadStatsData(): Promise<any> {
        try {
            const pluginAny = this.plugin as any;
            return await pluginAny.loadStatsData();
        } catch (error) {
            console.error('Failed to load stats data:', error);
            return null;
        }
    }

    private processStatsData(statsData: any): {
        realScoreData: ChartData;
        effectiveScoreData: ChartData;
        dailyActionsData: ChartData;
    } {

        let startDate: Date;
        let dateLabels: string[];
        let dateMap: { [date: string]: number } = {};

        // Generate date labels based on this.daysLimit
        startDate = new Date();
        startDate.setDate(startDate.getDate() - this.daysLimit);
        dateLabels = [];
        for (let i = this.daysLimit - 1; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            dateLabels.push(dateStr);
            dateMap[dateStr] = (this.daysLimit - 1) - i;
        }

        // Process each project
        const allProjectNames = Object.keys(statsData.projects);

        if (allProjectNames.length === 0) {
            console.warn('StatsModal: No projects found in stats data');
            throw new Error('No projects found in statistics data');
        }

        // Map projects with scores and Levenshtein distance
        const mappedProjects = allProjectNames.map(projectPath => {
            const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
            const score = statsData.projects[projectPath].currentScore + statsData.projects[projectPath].rotationBonus;
            const distance = this.searchTerm.trim() ? this.calculateLevenshteinDistance(projectName.toLowerCase(), this.searchTerm.trim().toLowerCase()) : 0;
            return { path: projectPath, score, distance, projectName };
        });

        if (this.searchTerm.trim()) {
            const searchLower = this.searchTerm.trim().toLowerCase();
            mappedProjects.forEach(p => {
                if (p.projectName.toLowerCase().includes(searchLower)) {
                    p.distance = -1; // Exact substring match gets top priority
                }
            });
            // Sort primarily by distance, secondarily by score
            mappedProjects.sort((a, b) => {
                if (a.distance !== b.distance) {
                    return a.distance - b.distance;
                }
                return b.score - a.score;
            });
        } else {
            // Sort by score
            mappedProjects.sort((a, b) => b.score - a.score);
        }

        // Apply limit based on projectsLimit
        let projectNames = mappedProjects.slice(0, this.projectsLimit).map(p => p.path);

        // Apply selection filter if any projects are selected
        if (this.selectedProjects.size > 0) {
            // Keep only selected projects that belong to the current list
            projectNames = projectNames.filter(path => this.selectedProjects.has(path));
        }

        const colors = this.generateColors(projectNames.length);

        // Real score data
        const realScoreData: ChartData = {
            labels: dateLabels,
            datasets: []
        };

        // Effective score data
        const effectiveScoreData: ChartData = {
            labels: dateLabels,
            datasets: []
        };

        // Daily actions data
        const dailyActionsData: ChartData = {
            labels: dateLabels,
            datasets: []
        };

        // --- REPLAY LOGIC START ---

        // 1. Gather all events
        interface ReviewEvent {
            date: Date;
            projectPath: string;
            scoreAfter: number;
        }
        const allEvents: ReviewEvent[] = [];
        Object.keys(statsData.projects).forEach(path => {
            const proj = statsData.projects[path];
            proj.reviewHistory.forEach((r: any) => {
                allEvents.push({
                    date: new Date(r.date),
                    projectPath: path,
                    scoreAfter: r.scoreAfter
                });
            });
        });
        allEvents.sort((a, b) => a.date.getTime() - b.date.getTime());

        // 2. Setup replay state
        const projectStates: { [path: string]: { currentScore: number, bonusSnapshot: number } } = {};
        Object.keys(statsData.projects).forEach(p => {
            projectStates[p] = {
                currentScore: (this.plugin as any).settings.defaultScore || 50,
                bonusSnapshot: 0
            };
        });
        let globalRotationAccumulator = 0;
        const rotationBonusAmount = (this.plugin as any).settings.rotationBonus || 0.1;

        // 3. Prepare datasets maps
        const realScoreMap: { [path: string]: (number | null)[] } = {};
        const effectiveScoreMap: { [path: string]: (number | null)[] } = {};
        const dailyActionsMap: { [path: string]: number[] } = {};

        projectNames.forEach(p => {
            const len = dateLabels.length;
            realScoreMap[p] = new Array(len).fill(null);
            effectiveScoreMap[p] = new Array(len).fill(null);
            dailyActionsMap[p] = new Array(len).fill(0);
        });

        // 4. Generate Time Steps (matching dateLabels)
        // We need the end of each bucket to snapshot state
        const timeSteps: Date[] = [];
        const now = new Date();

        if (this.daysLimit <= 1) { // Same as "day" mode logic if user selects 1 day
            for (let i = 23; i >= 0; i--) {
                const d = new Date();
                d.setHours(d.getHours() - i);
                d.setMinutes(59, 59, 999); // End of the hour
                timeSteps.push(d);
            }
        } else {
            for (let i = this.daysLimit - 1; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                d.setHours(23, 59, 59, 999); // End of the day
                timeSteps.push(d);
            }
        }

        // 5. Replay
        let currentEventIdx = 0;

        timeSteps.forEach((stepDate, timeIndex) => {
            // Apply all events up to this stepDate
            while (currentEventIdx < allEvents.length && allEvents[currentEventIdx].date <= stepDate) {
                const event = allEvents[currentEventIdx];

                // Update state
                if (!projectStates[event.projectPath]) {
                    projectStates[event.projectPath] = {
                        currentScore: (this.plugin as any).settings.defaultScore || 50,
                        bonusSnapshot: globalRotationAccumulator
                    };
                }

                projectStates[event.projectPath].currentScore = event.scoreAfter;
                projectStates[event.projectPath].bonusSnapshot = globalRotationAccumulator;

                // Logic: "stats.projects[filePath].rotationBonus = ... + bonusAmount;" for all except current
                // In relative model: Score = Base + (Global - Snapshot).
                // If we increase Global, everyone's bonus increases. 
                // Since this project just reset snapshot to Global, its bonus is 0.
                globalRotationAccumulator += rotationBonusAmount;

                // Count actions for dailyActions graph
                if (projectNames.includes(event.projectPath)) {
                    // Find which bucket this event belongs to
                    let bucketIndex = -1;
                    if (this.daysLimit <= 1) {
                        // Match hour
                        const h = event.date.getHours().toString().padStart(2, '0') + ':00';
                        if (dateMap[h] !== undefined) bucketIndex = dateMap[h];
                    } else {
                        // Match date
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

                // Calculate Rotation Bonus
                // Careful: if the project was never initialized (no events ever), 
                // it should perhaps start with bonus 0?
                // In my logic, I init them with `bonusSnapshot: 0`.
                // If `globalRotationAccumulator` has grown to 100, then `100 - 0 = 100` bonus. 
                // This implies existing projects accumulate bonus even before first review? 
                // Yes, that's how the plugin works (incrementRotationBonus iterates all projects).

                const rotationBonus = globalRotationAccumulator - state.bonusSnapshot;

                // Calculate Deadline Bonus
                const deadline = this.deadlines[path];
                const deadlineBonus = this.calculateDeadlineBonus(state.currentScore, stepDate, deadline);

                const effective = state.currentScore + rotationBonus + deadlineBonus;

                effectiveScoreMap[path][timeIndex] = effective;
                realScoreMap[path][timeIndex] = state.currentScore;
            });
        });

        // --- REPLAY LOGIC END ---

        projectNames.forEach((projectPath, index) => {
            const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
            const color = colors[index];

            const realScores = realScoreMap[projectPath];
            const effectiveScores = effectiveScoreMap[projectPath];
            const dailyActions = dailyActionsMap[projectPath];

            // Add datasets
            const realScoreDataset = {
                label: projectName,
                data: realScores as number[],
                borderColor: color,
                backgroundColor: color + '20',
                fill: false,
                tension: 0.1
            };
            realScoreData.datasets.push(realScoreDataset);

            const effectiveScoreDataset = {
                label: projectName,
                data: effectiveScores as number[],
                borderColor: color,
                backgroundColor: color + '20',
                fill: false,
                tension: 0.1
            };
            effectiveScoreData.datasets.push(effectiveScoreDataset);

            const dailyActionsDataset = {
                label: projectName,
                data: dailyActions,
                borderColor: color,
                backgroundColor: color + '80'
            };
            dailyActionsData.datasets.push(dailyActionsDataset);
        });


        // Verification of datasets is removed to allow empty search results without throwing an error

        if (dailyActionsData.datasets.length === 0) {
            throw new Error('No datasets generated for daily actions chart');
        }

        return {
            realScoreData,
            effectiveScoreData,
            dailyActionsData
        };
    }

    private interpolateMissingValues(data: number[]): void {
        for (let i = 0; i < data.length; i++) {
            if (data[i] === null) {
                // Find previous non-null value
                let prevValue = null;
                for (let j = i - 1; j >= 0; j--) {
                    if (data[j] !== null) {
                        prevValue = data[j];
                        break;
                    }
                }

                // Find next non-null value
                let nextValue = null;
                for (let j = i + 1; j < data.length; j++) {
                    if (data[j] !== null) {
                        nextValue = data[j];
                        break;
                    }
                }

                // Interpolate or use available value
                if (prevValue !== null && nextValue !== null) {
                    data[i] = (prevValue + nextValue) / 2;
                } else if (prevValue !== null) {
                    data[i] = prevValue;
                } else if (nextValue !== null) {
                    data[i] = nextValue;
                } else {
                    data[i] = 0; // Default fallback
                }
            }
        }
    }

    private generateColors(count: number): string[] {
        const colors = [
            '#3b82f6', // blue
            '#ef4444', // red
            '#10b981', // green
            '#f59e0b', // yellow
            '#8b5cf6', // purple
            '#06b6d4', // cyan
            '#f97316', // orange
            '#84cc16', // lime
            '#ec4899', // pink
            '#6b7280'  // gray
        ];

        const result: string[] = [];
        for (let i = 0; i < count; i++) {
            result.push(colors[i % colors.length]);
        }
        return result;
    }

    private createChartContainers(chartData: {
        realScoreData: ChartData;
        effectiveScoreData: ChartData;
        dailyActionsData: ChartData;
    }, statsData: any): void {

        // Verify Chart.js is available - Fail-Fast approach
        if (typeof (window as any).Chart === 'undefined') {
            const errorMsg = 'Chart.js is not available on window object. Cannot create charts.';
            console.error('StatsModal:', errorMsg);
            throw new Error(errorMsg);
        }

        const Chart = (window as any).Chart;

        // Create containers for each chart
        const chartsContainer = this.contentEl.createEl('div', { cls: 'stats-charts-container' });

        // Create projects list at the top of the charts container
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
                    x: {
                        display: true,
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        beginAtZero: false,
                        min: 0,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            usePointStyle: true,
                            padding: 20
                        }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                elements: {
                    point: {
                        radius: 3,
                        hoverRadius: 6
                    },
                    line: {
                        borderWidth: 2
                    }
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
                    x: {
                        stacked: true,
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            usePointStyle: true,
                            padding: 20
                        }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                elements: {
                    bar: {
                        borderWidth: 0
                    }
                }
            }
        }));
        
        this.createDynamicControls(dailyActionsContainer);
    }

    onClose() {
        // Destroy all chart instances to prevent memory leaks
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
            
            // Re-focus the input after refresh
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
        // Clear existing charts
        this.chartInstances.forEach(chart => {
            if (chart && typeof chart.destroy === 'function') {
                chart.destroy();
            }
        });
        this.chartInstances = [];

        // Remove existing charts container (which includes projects list)
        const chartsContainer = this.contentEl.querySelector('.stats-charts-container');
        if (chartsContainer) {
            chartsContainer.remove();
        }

        try {
            // Reload and process data
            const statsData = await this.loadStatsData();
            const chartData = this.processStatsData(statsData);

            // Create chart containers (includes projects list at the top)
            this.createChartContainers(chartData, statsData);
        } catch (error) {
            console.error('StatsModal: Error refreshing charts:', error);
        }
    }
    private createProjectsListInContainer(statsData: any, container: HTMLElement): void {
        if (!statsData || !statsData.projects) {
            return;
        }

        // Create projects list container inside the charts container
        const projectsContainer = container.createEl('div', { cls: 'projects-list-container' });

        // Add title with limit info
        const titleEl = projectsContainer.createEl('h3', {
            text: `Liste des Projets par Priorité (Max: ${this.projectsLimit})`,
            cls: 'projects-list-title'
        });

        // Calculate time spent and priority for each project
        const projectStats = this.calculateProjectStats(statsData);

        // Map distance for search
        const mappedProjectStats = projectStats.map(p => {
            const distance = this.searchTerm.trim() ? this.calculateLevenshteinDistance(p.name.toLowerCase(), this.searchTerm.trim().toLowerCase()) : 0;
            return { ...p, distance };
        });

        // Apply sorting (Levenshtein then Priority)
        if (this.searchTerm.trim()) {
            const searchLower = this.searchTerm.trim().toLowerCase();
            mappedProjectStats.forEach(p => {
                if (p.name.toLowerCase().includes(searchLower)) {
                    p.distance = -1; // Exact match top priority
                }
            });
            mappedProjectStats.sort((a, b) => {
                if (a.distance !== b.distance) {
                    return a.distance - b.distance;
                }
                return b.effectiveScore - a.effectiveScore;
            });
        } else {
            mappedProjectStats.sort((a, b) => b.effectiveScore - a.effectiveScore);
        }

        // Apply limits
        let filteredProjectStats = mappedProjectStats.slice(0, this.projectsLimit);

        // Create projects grid
        const projectsGrid = projectsContainer.createEl('div', { cls: 'projects-grid' });

        filteredProjectStats.forEach((project, index) => {
            const isSelected = this.selectedProjects.has(project.path);
            const projectCard = projectsGrid.createEl('div', {
                cls: `project-card ${isSelected ? 'is-selected' : ''}`
            });
            projectCard.setAttribute('style', `--project-color: ${project.color}; --project-index: ${index};`);

            // Add click listener to card for selection
            projectCard.addEventListener('click', (e) => {
                // If clicking urgent button, don't toggle selection
                if ((e.target as HTMLElement).closest('.urgent-btn')) return;

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
                this.handleUrgentAction(project.path);
            });

            // Project name
            const nameEl = projectCard.createEl('div', {
                text: project.name,
                cls: 'project-name'
            });

            // Time spent
            const timeEl = projectCard.createEl('div', {
                text: this.formatTimeSpent(project.timeSpent),
                cls: 'project-time'
            });

            // Priority score
            const scoreEl = projectCard.createEl('div', {
                text: `Priorité: ${project.effectiveScore.toFixed(1)}`,
                cls: 'project-priority'
            });

            // Reviews count
            const reviewsEl = projectCard.createEl('div', {
                text: `${project.totalReviews} reviews`,
                cls: 'project-reviews'
            });
        });

        this.createDynamicControls(projectsContainer);
    }

    private async handleUrgentAction(projectPath: string) {
        try {
            const pluginAny = this.plugin as any;
            let s = await pluginAny.getProjectScore(projectPath);
            const rapprochment = Number(pluginAny.settings.rapprochementFactor ?? 0.2);
            const gain = rapprochment * (100 - s);
            const newScore = s + gain;

            await pluginAny.updateProjectScore(projectPath, newScore);
            await pluginAny.incrementRotationBonus(projectPath);
            await pluginAny.recordReviewAction(projectPath, 'more-often', newScore);

            const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
            // @ts-ignore
            new Notice(`Projet "${projectName}" marqué comme urgent !`);
            
            this.refreshCharts();
        } catch (error) {
            console.error('StatsModal: Error handling urgent action:', error);
            // @ts-ignore
            new Notice('Erreur lors du marquage comme urgent.');
        }
    }

    private calculateProjectStats(statsData: any): Array<{
        name: string;
        path: string;
        timeSpent: number;
        effectiveScore: number;
        totalReviews: number;
        color: string;
    }> {
        const projectNames = Object.keys(statsData.projects);
        const colors = this.generateColors(projectNames.length);

        return projectNames.map((projectPath, index) => {
            const project = statsData.projects[projectPath];
            const projectName = projectPath.split('/').pop()?.replace('.md', '') || projectPath;
            const color = colors[index];

            // Calculate time spent based on reviews (assuming 25 minutes per review)
            const timeSpent = project.totalReviews * 25; // minutes

            // Calculate effective score (current score + rotation bonus)
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

    private formatTimeSpent(minutes: number): string {
        if (minutes < 60) {
            return `${minutes} min`;
        } else if (minutes < 1440) { // less than 24 hours
            const hours = Math.floor(minutes / 60);
            const remainingMinutes = minutes % 60;
            return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}min` : `${hours}h`;
        } else {
            const days = Math.floor(minutes / 1440);
            const remainingHours = Math.floor((minutes % 1440) / 60);
            return remainingHours > 0 ? `${days}j ${remainingHours}h` : `${days}j`;
        }
    }

    private calculateDeadlineBonus(baseScore: number, currentDate: Date, deadlineStr?: string): number {
        if (!deadlineStr) return 0;

        const deadlineDate = new Date(deadlineStr);
        if (isNaN(deadlineDate.getTime())) return 0;

        // Reset time parts for day diff calculation
        const today = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
        const deadlineDay = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());

        const diffTime = deadlineDay.getTime() - today.getTime();
        const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        let factor = 1.0;
        if (daysRemaining > 0) {
            factor = Math.exp(-0.1 * daysRemaining);
        }
        // If daysRemaining <= 0, factor is 1.0 (max urgency)

        const gap = 100 - baseScore;
        if (gap > 0) {
            return gap * factor;
        }
        return 0;
    }
}
