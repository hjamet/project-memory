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
        titleEl.style.marginBottom = '1.5rem';

        try {
            console.log('StatsModal: Starting initialization...');

            // Load Chart.js from CDN
            console.log('StatsModal: Loading Chart.js...');
            await this.loadChartJS();
            console.log('StatsModal: Chart.js loaded successfully');

            // Load and process stats data
            console.log('StatsModal: Loading stats data...');
            const statsData = await this.loadStatsData();
            console.log('StatsModal: Stats data loaded:', statsData);

            if (!statsData || Object.keys(statsData.projects).length === 0) {
                console.log('StatsModal: No project data found');
                this.contentEl.createEl('p', {
                    text: 'Aucune donnée statistique disponible. Utilisez le système de review pour générer des données.',
                    cls: 'no-data-message'
                });
                return;
            }

            // Process data for charts
            console.log('StatsModal: Processing stats data...');
            const chartData = this.processStatsData(statsData);
            console.log('StatsModal: Chart data processed:', chartData);

            // Create chart containers
            console.log('StatsModal: Creating chart containers...');
            this.createChartContainers(chartData);
            console.log('StatsModal: Charts created successfully');

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

            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.min.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load Chart.js'));
            document.head.appendChild(script);
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
        console.log('StatsModal: Starting data processing...');
        console.log('StatsModal: Raw stats data:', statsData);

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Generate date labels for the last 30 days
        const dateLabels: string[] = [];
        const dateMap: { [date: string]: number } = {};
        for (let i = 29; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            dateLabels.push(dateStr);
            dateMap[dateStr] = 29 - i;
        }
        console.log('StatsModal: Generated date labels:', dateLabels);

        // Process each project
        const projectNames = Object.keys(statsData.projects);
        console.log('StatsModal: Found projects:', projectNames);

        if (projectNames.length === 0) {
            console.warn('StatsModal: No projects found in stats data');
            throw new Error('No projects found in statistics data');
        }

        const colors = this.generateColors(projectNames.length);
        console.log('StatsModal: Generated colors:', colors);

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
            console.log(`StatsModal: Processing project ${index + 1}/${projectNames.length}: ${projectPath}`);
            const project = statsData.projects[projectPath];
            const projectName = projectPath.replace('.md', '');
            const color = colors[index];

            console.log(`StatsModal: Project ${projectName} data:`, project);

            // Initialize data arrays for this project
            const realScores = new Array(30).fill(null);
            const effectiveScores = new Array(30).fill(null);
            const dailyActions = new Array(30).fill(0);

            // Process review history
            console.log(`StatsModal: Processing ${project.reviewHistory.length} reviews for ${projectName}`);
            project.reviewHistory.forEach((review: any, reviewIndex: number) => {
                console.log(`StatsModal: Review ${reviewIndex + 1}:`, review);
                const reviewDate = new Date(review.date).toISOString().split('T')[0];
                const dayIndex = dateMap[reviewDate];

                if (dayIndex !== undefined) {
                    // Real score
                    realScores[dayIndex] = review.scoreAfter;

                    // Effective score (scoreAfter + current rotationBonus)
                    effectiveScores[dayIndex] = review.scoreAfter + project.rotationBonus;

                    // Daily actions count
                    dailyActions[dayIndex]++;

                    console.log(`StatsModal: Added review data for day ${dayIndex} (${reviewDate}): score=${review.scoreAfter}, effective=${review.scoreAfter + project.rotationBonus}`);
                } else {
                    console.log(`StatsModal: Review date ${reviewDate} is outside 30-day window, skipping`);
                }
            });

            // Interpolate missing values for line charts
            console.log(`StatsModal: Interpolating missing values for ${projectName}`);
            console.log(`StatsModal: Real scores before interpolation:`, realScores);
            this.interpolateMissingValues(realScores);
            console.log(`StatsModal: Real scores after interpolation:`, realScores);

            console.log(`StatsModal: Effective scores before interpolation:`, effectiveScores);
            this.interpolateMissingValues(effectiveScores);
            console.log(`StatsModal: Effective scores after interpolation:`, effectiveScores);

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
            console.log(`StatsModal: Added real score dataset for ${projectName}:`, realScoreDataset);

            const effectiveScoreDataset = {
                label: projectName,
                data: effectiveScores,
                borderColor: color,
                backgroundColor: color + '20',
                fill: false,
                tension: 0.1
            };
            effectiveScoreData.datasets.push(effectiveScoreDataset);
            console.log(`StatsModal: Added effective score dataset for ${projectName}:`, effectiveScoreDataset);

            const dailyActionsDataset = {
                label: projectName,
                data: dailyActions,
                borderColor: color,
                backgroundColor: color + '80'
            };
            dailyActionsData.datasets.push(dailyActionsDataset);
            console.log(`StatsModal: Added daily actions dataset for ${projectName}:`, dailyActionsDataset);
        });

        console.log('StatsModal: Final processed data:');
        console.log('StatsModal: Real score data:', realScoreData);
        console.log('StatsModal: Effective score data:', effectiveScoreData);
        console.log('StatsModal: Daily actions data:', dailyActionsData);

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
    }): void {
        console.log('StatsModal: Checking Chart.js availability...');

        // Verify Chart.js is available - Fail-Fast approach
        if (typeof (window as any).Chart === 'undefined') {
            const errorMsg = 'Chart.js is not available on window object. Cannot create charts.';
            console.error('StatsModal:', errorMsg);
            throw new Error(errorMsg);
        }

        const Chart = (window as any).Chart;
        console.log('StatsModal: Chart.js is available, creating charts...');

        // Create containers for each chart
        const chartsContainer = this.contentEl.createEl('div', { cls: 'stats-charts-container' });

        // Real Score Chart
        console.log('StatsModal: Creating Real Score Chart...');
        console.log('StatsModal: Real Score Data:', chartData.realScoreData);
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
                    y: {
                        beginAtZero: false,
                        min: 0,
                        max: 100
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    }
                }
            }
        }));
        console.log('StatsModal: Real Score Chart created');

        // Effective Score Chart
        console.log('StatsModal: Creating Effective Score Chart...');
        console.log('StatsModal: Effective Score Data:', chartData.effectiveScoreData);
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
                    y: {
                        beginAtZero: false,
                        min: 0
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    }
                }
            }
        }));
        console.log('StatsModal: Effective Score Chart created');

        // Daily Actions Chart
        console.log('StatsModal: Creating Daily Actions Chart...');
        console.log('StatsModal: Daily Actions Data:', chartData.dailyActionsData);
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
                        stacked: true
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    }
                }
            }
        }));
        console.log('StatsModal: Daily Actions Chart created');
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
}
