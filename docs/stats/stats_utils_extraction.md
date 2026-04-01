# statsUtils.ts — Shared Business Logic Module

## Motivation
Before this extraction, `StatsModal.ts` contained ~1053 lines mixing business logic, UI rendering, and modal lifecycle. With the new `StatsView` (sidebar) needing the exact same logic, duplication was unacceptable.

## Extracted Functions

| Function | Purpose | Lines (approx) |
|----------|---------|----------------|
| `calculateLevenshteinDistance(a, b)` | Edit distance for fuzzy search | ~15 |
| `generateColors(count)` | Deterministic color palette | ~10 |
| `formatTimeSpent(minutes)` | Human-readable duration | ~12 |
| `calculateDeadlineBonus(base, date, deadline?)` | Urgency bonus from deadline proximity | ~20 |
| `interpolateMissingValues(data)` | Fill null gaps in time series | ~20 |
| `filterArchivedProjects(paths, plugin)` | Exclude projects with archive tag | ~15 |
| `loadDeadlines(plugin)` | Read deadline frontmatter for all files | ~10 |
| `loadStatsData(plugin)` | Fetch stats from plugin storage | ~5 |
| `loadChartJS()` | CDN script injection with idempotent guard | ~40 |
| `computeSearchSimilarity(name, term)` | Combined substring + Levenshtein scoring | ~10 |
| `processStatsData(data, options)` | Full replay mechanism for chart datasets | ~150 |
| `calculateProjectStats(data, plugin)` | Project card stats (time, score, reviews) | ~25 |
| `handleUrgentAction(path, plugin)` | Emergency score boost | ~15 |

## Exported Interfaces
- `ChartData`, `ChartDataset` — Chart.js-ready data structures
- `DailyActions` — Per-date per-project action counts
- `ProjectStatEntry` — Single project card data
- `ProcessedChartData` — Container for all three chart datasets
- `StatsProcessingOptions` — Input options for `processStatsData()`

## Consumers
- `StatsModal.ts` — Full-screen modal (imports all functions)
- `StatsView.ts` — Sidebar view (imports all functions)
