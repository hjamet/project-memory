# Stats Sidebar View

## Description
The `StatsView` class (`src/StatsView.ts`) is an Obsidian `ItemView` that renders project statistics in the right sidebar panel. It provides the same features as the full-screen `StatsModal` but with a compact portrait layout optimized for ~300-400px width.

## Features
- **Project cards** — Single-column stack with header (name + action buttons) and inline stats row
- **Chart.js graphs** — Effective Score (line) and Daily Actions (bar) with 200px height
- **Search** — Levenshtein-powered search bar
- **Controls** — Compact +/- buttons for days limit and projects limit
- **Urgency** (🚨) — Emergency score boost without counting as review
- **Open note** (📄) — Navigate to project file
- **Project selection** — Click card to isolate its curve on charts
- **Auto-refresh** — View automatically refreshes after each review action via `refreshStatsSidebar()` in `main.ts`

## Registration
- `registerView(VIEW_TYPE_STATS, ...)` in `main.ts`
- Command: `toggle-stats-sidebar` ("Toggle project statistics sidebar")
- Opens in right leaf by default
- Persists across Obsidian reloads via workspace serialization

## CSS
All styles are scoped under `.projects-memory-stats-view` in `styles.css` with `sv-` prefixed class names to avoid conflicts with the modal's styles.
