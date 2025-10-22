import { App, Modal, Plugin } from 'obsidian';

type ViewMode = 'month' | 'week' | 'day';

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
    private currentViewMode: ViewMode = 'month';

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

        // Create view mode selector
        this.createViewModeSelector();

        try {
            // Load Chart.js from CDN
            await this.loadChartJS();

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

        // Generate date labels based on current view mode
        switch (this.currentViewMode) {
            case 'month':
                startDate = new Date();
                startDate.setDate(startDate.getDate() - 30);
                dateLabels = [];
                for (let i = 29; i >= 0; i--) {
                    const date = new Date();
                    date.setDate(date.getDate() - i);
                    const dateStr = date.toISOString().split('T')[0];
                    dateLabels.push(dateStr);
                    dateMap[dateStr] = 29 - i;
                }
                break;

            case 'week':
                startDate = new Date();
                startDate.setDate(startDate.getDate() - 7);
                dateLabels = [];
                for (let i = 6; i >= 0; i--) {
                    const date = new Date();
                    date.setDate(date.getDate() - i);
                    const dateStr = date.toISOString().split('T')[0];
                    dateLabels.push(dateStr);
                    dateMap[dateStr] = 6 - i;
                }
                break;

            case 'day':
                startDate = new Date();
                startDate.setHours(startDate.getHours() - 24);
                dateLabels = [];
                for (let i = 23; i >= 0; i--) {
                    const date = new Date();
                    date.setHours(date.getHours() - i);
                    const hourStr = date.getHours().toString().padStart(2, '0') + ':00';
                    dateLabels.push(hourStr);
                    dateMap[hourStr] = 23 - i;
                }
                break;
        }

        // Process each project
        const projectNames = Object.keys(statsData.projects);

        if (projectNames.length === 0) {
            console.warn('StatsModal: No projects found in stats data');
            throw new Error('No projects found in statistics data');
        }

        const colors = this.generateColors(projectNames.length);

        // Real score data (scoreAfter from reviewHistory)
        const realScoreData: ChartData = {
            labels: dateLabels,
            datasets: []
        };

        // Effective score data (scoreAfter + rotationBonus)
        const effectiveScoreData: ChartData = {
            labels: dateLabels,
            datasets: []
        };

        // Daily actions data
        const dailyActionsData: ChartData = {
            labels: dateLabels,
            datasets: []
        };

        projectNames.forEach((projectPath, index) => {
            const project = statsData.projects[projectPath];
            const projectName = projectPath.replace('.md', '');
            const color = colors[index];

            // Initialize data arrays for this project
            const arrayLength = dateLabels.length;
            const realScores = new Array(arrayLength).fill(null);
            const effectiveScores = new Array(arrayLength).fill(null);
            const dailyActions = new Array(arrayLength).fill(0);

            // Process review history
            project.reviewHistory.forEach((review: any, reviewIndex: number) => {
                const reviewDate = new Date(review.date);
                let timeKey: string;
                let timeIndex: number;

                if (this.currentViewMode === 'day') {
                    // For day mode, use hour as key
                    const hour = reviewDate.getHours();
                    timeKey = hour.toString().padStart(2, '0') + ':00';
                    timeIndex = dateMap[timeKey];
                } else {
                    // For month/week modes, use date as key
                    timeKey = reviewDate.toISOString().split('T')[0];
                    timeIndex = dateMap[timeKey];
                }

                if (timeIndex !== undefined) {
                    // Real score
                    realScores[timeIndex] = review.scoreAfter;

                    // Effective score (scoreAfter + current rotationBonus)
                    effectiveScores[timeIndex] = review.scoreAfter + project.rotationBonus;

                    // Daily actions count
                    dailyActions[timeIndex]++;

                }
            });

            // Interpolate missing values for line charts
            this.interpolateMissingValues(realScores);
            this.interpolateMissingValues(effectiveScores);

            // Add datasets
            const realScoreDataset = {
                label: projectName,
                data: realScores,
                borderColor: color,
                backgroundColor: color + '20',
                fill: false,
                tension: 0.1
            };
            realScoreData.datasets.push(realScoreDataset);

            const effectiveScoreDataset = {
                label: projectName,
                data: effectiveScores,
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


        // Verify datasets are not empty
        if (realScoreData.datasets.length === 0) {
            throw new Error('No datasets generated for real score chart');
        }
        if (effectiveScoreData.datasets.length === 0) {
            throw new Error('No datasets generated for effective score chart');
        }
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

        // Real Score Chart
        const realScoreContainer = chartsContainer.createEl('div', { cls: 'chart-container' });
        realScoreContainer.createEl('h3', { text: 'Évolution du Score Réel', cls: 'chart-title' });
        const realScoreCanvas = realScoreContainer.createEl('canvas', { cls: 'chart-canvas' });

        this.chartInstances.push(new Chart(realScoreCanvas, {
            type: 'line',
            data: chartData.realScoreData,
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
                        max: 100,
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

        // Daily Actions Chart (or Timeline for day mode)
        const dailyActionsContainer = chartsContainer.createEl('div', { cls: 'chart-container' });

        if (this.currentViewMode === 'day') {
            // Create timeline chart for day mode
            dailyActionsContainer.createEl('h3', { text: 'Chronologie des Reviews', cls: 'chart-title' });
            const timelineCanvas = dailyActionsContainer.createEl('canvas', { cls: 'chart-canvas' });

            // Generate timeline data for day mode
            const timelineData = this.generateTimelineData();

            this.chartInstances.push(new Chart(timelineCanvas, {
                type: 'scatter',
                data: timelineData,
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            type: 'time',
                            time: {
                                unit: 'hour',
                                displayFormats: {
                                    hour: 'HH:mm'
                                }
                            },
                            title: {
                                display: true,
                                text: 'Heure'
                            },
                            grid: {
                                display: false
                            }
                        },
                        y: {
                            type: 'category',
                            labels: this.getProjectNames(),
                            title: {
                                display: true,
                                text: 'Projet'
                            },
                            grid: {
                                color: 'rgba(0, 0, 0, 0.1)'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            callbacks: {
                                title: (context: any) => {
                                    const point = context[0];
                                    return `Review à ${point.parsed.x}`;
                                },
                                label: (context: any) => {
                                    const point = context.parsed;
                                    return `Projet: ${point.y}`;
                                }
                            }
                        }
                    },
                    elements: {
                        point: {
                            radius: 6,
                            hoverRadius: 8
                        }
                    }
                }
            }));
        } else {
            // Regular bar chart for month/week modes
            const chartTitle = this.currentViewMode === 'week' ? 'Actions par Semaine' : 'Actions par Jour';
            dailyActionsContainer.createEl('h3', { text: chartTitle, cls: 'chart-title' });
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
        }
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

    private createViewModeSelector(): void {
        const selectorContainer = this.contentEl.createEl('div', { cls: 'stats-view-selector' });

        const modes: { mode: ViewMode; label: string }[] = [
            { mode: 'month', label: 'Mois' },
            { mode: 'week', label: 'Semaine' },
            { mode: 'day', label: 'Jour' }
        ];

        modes.forEach(({ mode, label }) => {
            const button = selectorContainer.createEl('button', {
                text: label,
                cls: `view-mode-btn ${this.currentViewMode === mode ? 'view-mode-btn-active' : ''}`
            });

            button.addEventListener('click', () => {
                this.currentViewMode = mode;
                this.refreshCharts();
            });
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

        // Update button states
        const buttons = this.contentEl.querySelectorAll('.view-mode-btn');
        buttons.forEach(btn => {
            btn.classList.remove('view-mode-btn-active');
        });

        const activeButton = this.contentEl.querySelector(`[data-mode="${this.currentViewMode}"]`) ||
            Array.from(buttons).find(btn => btn.textContent === this.getModeLabel(this.currentViewMode));
        if (activeButton) {
            activeButton.classList.add('view-mode-btn-active');
        }

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

    private getModeLabel(mode: ViewMode): string {
        switch (mode) {
            case 'month': return 'Mois';
            case 'week': return 'Semaine';
            case 'day': return 'Jour';
        }
    }

    private generateTimelineData(): any {
        const statsData = (this as any).plugin.loadStatsData ?
            (this as any).plugin.loadStatsData() :
            this.loadStatsData();

        if (!statsData || !statsData.projects) {
            return { datasets: [] };
        }

        const projectNames = Object.keys(statsData.projects);
        const colors = this.generateColors(projectNames.length);
        const datasets: any[] = [];

        projectNames.forEach((projectPath, index) => {
            const project = statsData.projects[projectPath];
            const projectName = projectPath.replace('.md', '');
            const color = colors[index];

            const points: { x: string; y: string }[] = [];

            // Get reviews from the last 24 hours
            const twentyFourHoursAgo = new Date();
            twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

            project.reviewHistory.forEach((review: any) => {
                const reviewDate = new Date(review.date);
                if (reviewDate >= twentyFourHoursAgo) {
                    points.push({
                        x: reviewDate.toISOString(),
                        y: projectName
                    });
                }
            });

            if (points.length > 0) {
                datasets.push({
                    label: projectName,
                    data: points,
                    backgroundColor: color,
                    borderColor: color,
                    pointRadius: 6,
                    pointHoverRadius: 8
                });
            }
        });

        return { datasets };
    }

    private getProjectNames(): string[] {
        const statsData = (this as any).plugin.loadStatsData ?
            (this as any).plugin.loadStatsData() :
            this.loadStatsData();

        if (!statsData || !statsData.projects) {
            return [];
        }

        return Object.keys(statsData.projects).map(path => path.replace('.md', ''));
    }

    private createProjectsList(statsData: any): void {
        if (!statsData || !statsData.projects) {
            return;
        }

        // Create projects list container
        const projectsContainer = this.contentEl.createEl('div', { cls: 'projects-list-container' });

        // Add title
        const titleEl = projectsContainer.createEl('h3', {
            text: 'Liste des Projets par Priorité',
            cls: 'projects-list-title'
        });

        // Calculate time spent and priority for each project
        const projectStats = this.calculateProjectStats(statsData);

        // Sort by priority (effective score)
        projectStats.sort((a, b) => b.effectiveScore - a.effectiveScore);

        // Create projects grid
        const projectsGrid = projectsContainer.createEl('div', { cls: 'projects-grid' });

        projectStats.forEach((project, index) => {
            const projectCard = projectsGrid.createEl('div', {
                cls: 'project-card'
            });
            projectCard.setAttribute('style', `--project-color: ${project.color}; --project-index: ${index};`);

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
    }

    private createProjectsListInContainer(statsData: any, container: HTMLElement): void {
        if (!statsData || !statsData.projects) {
            return;
        }

        // Create projects list container inside the charts container
        const projectsContainer = container.createEl('div', { cls: 'projects-list-container' });

        // Add title
        const titleEl = projectsContainer.createEl('h3', {
            text: 'Liste des Projets par Priorité',
            cls: 'projects-list-title'
        });

        // Calculate time spent and priority for each project
        const projectStats = this.calculateProjectStats(statsData);

        // Sort by priority (effective score)
        projectStats.sort((a, b) => b.effectiveScore - a.effectiveScore);

        // Create projects grid
        const projectsGrid = projectsContainer.createEl('div', { cls: 'projects-grid' });

        projectStats.forEach((project, index) => {
            const projectCard = projectsGrid.createEl('div', {
                cls: 'project-card'
            });
            projectCard.setAttribute('style', `--project-color: ${project.color}; --project-index: ${index};`);

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
    }

    private calculateProjectStats(statsData: any): Array<{
        name: string;
        timeSpent: number;
        effectiveScore: number;
        totalReviews: number;
        color: string;
    }> {
        const projectNames = Object.keys(statsData.projects);
        const colors = this.generateColors(projectNames.length);

        return projectNames.map((projectPath, index) => {
            const project = statsData.projects[projectPath];
            const projectName = projectPath.replace('.md', '');
            const color = colors[index];

            // Calculate time spent based on reviews (assuming 25 minutes per review)
            const timeSpent = project.totalReviews * 25; // minutes

            // Calculate effective score (current score + rotation bonus)
            const currentScore = project.currentScore || 50;
            const effectiveScore = currentScore + project.rotationBonus;

            return {
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
}
