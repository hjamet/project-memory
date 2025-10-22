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

            // Create chart containers
            this.createChartContainers(chartData);

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
            script.src = 'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js';

            script.onload = () => {
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
            };

            script.onerror = () => {
                console.error('StatsModal: Failed to load Chart.js script from CDN');
                reject(new Error('Failed to load Chart.js from CDN'));
            };

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
            const realScores = new Array(30).fill(null);
            const effectiveScores = new Array(30).fill(null);
            const dailyActions = new Array(30).fill(0);

            // Process review history
            project.reviewHistory.forEach((review: any, reviewIndex: number) => {
                const reviewDate = new Date(review.date).toISOString().split('T')[0];
                const dayIndex = dateMap[reviewDate];

                if (dayIndex !== undefined) {
                    // Real score
                    realScores[dayIndex] = review.scoreAfter;

                    // Effective score (scoreAfter + current rotationBonus)
                    effectiveScores[dayIndex] = review.scoreAfter + project.rotationBonus;

                    // Daily actions count
                    dailyActions[dayIndex]++;

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
    }): void {

        // Verify Chart.js is available - Fail-Fast approach
        if (typeof (window as any).Chart === 'undefined') {
            const errorMsg = 'Chart.js is not available on window object. Cannot create charts.';
            console.error('StatsModal:', errorMsg);
            throw new Error(errorMsg);
        }

        const Chart = (window as any).Chart;

        // Create containers for each chart
        const chartsContainer = this.contentEl.createEl('div', { cls: 'stats-charts-container' });

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
