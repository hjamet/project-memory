# Projects Memory — Obsidian plugin

Projects Memory is an Obsidian community plugin that helps you run lightweight, adaptive reviews of project notes inside your vault. It opens a review modal, suggests projects to review, updates frontmatter scores, and offers quick actions (e.g., deprioritize, archive).

This repository uses TypeScript and esbuild to produce the release artifact `main.js` which is loaded by Obsidian.

## Prerequisites & installation

- **Node.js** (LTS recommended, Node 18+)
- Install dependencies:

```
npm install
```

- Development (watch + build):

```
npm run dev
```

- Production build:

```
npm run build
```

After building, copy `main.js`, `manifest.json`, and `styles.css` to your vault under `/.obsidian/plugins/project-memory/` to test the plugin.

## Architecture

Root layout (important files):

```
src/                 # TypeScript source (modal, UI components)
main.ts              # Plugin entry: lifecycle & command registration
manifest.json        # Plugin manifest (id, name, version, minAppVersion)
styles.css           # Optional plugin styles scoped to the modal
esbuild.config.mjs   # Build configuration
data.json            # Plugin data blob (settings + stats, auto-generated)
stats.json.example   # Reference structure for the statistics payload
README.md            # This file
```

Key implementation files:
- `src/ReviewModal.ts`: UI and review logic for the modal used by the plugin.
- `src/StatsModal.ts`: Statistics visualization with Chart.js integration.
- `main.ts`: plugin onload/onunload, command registration, and statistics management.

## Important files & commands

- **`manifest.json`**: contains `id`, `name`, `version`, and `minAppVersion`. Ensure `id` matches the plugin folder name (`project-memory`) when installing locally.
- **Developer commands** (run via command palette while developing):

```
Review a project        # opens the review modal for the selected project
View project statistics # opens the statistics visualization modal
```

## Settings

The plugin exposes a small set of settings to tune review behavior:
- `defaultScore` — default pertinence score for new projects (default: 100)
- `archiveTag` — tag applied when marking a project as finished (default: `projet-fini`)
- `rotationBonus` — points added to all other projects when one project is worked on (default: 0.1)
- `rapprochementFactor` — fraction of remaining gap closed on each action (0..1, default: 0.2)
 - `recencyPenaltyWeight` — multiplier for the temporary per-session recency penalty applied to projects reviewed during the active session (default: 1.0). Set to `0` to disable the feature.

Settings are persisted using Obsidian's `loadData()` / `saveData()` APIs.

## Rotation Bonus System

The plugin uses a rotation-based bonus system instead of time-based bonuses. When you work on a project (click any action button except "Passer"), all other projects gain bonus points equal to the `rotationBonus` setting. This ensures that neglected projects gradually become more likely to be selected for review.

### Statistics Tracking

The plugin now persists all statistics inside the Obsidian-managed plugin data blob (`data.json`) through the `saveData()` / `loadData()` APIs. Settings and statistics share this file: settings live at the root level, while the statistics payload is stored under the `stats` key.

- **Per-project data**: current pertinence score, rotation bonus, total reviews, last review date, total Pomodoro time, and review history
- **Global statistics**: total reviews across all projects and aggregated Pomodoro time
- **Review history**: detailed log of actions taken on each project (last 100 entries per project)

`stats.json.example` documents the persisted structure and can be used for reference without touching the live data file.

The data blob is created and maintained automatically. Deleting `data.json` resets all statistics; the plugin recreates an empty payload on the next launch. Existing `pertinence_score` values in frontmatter are still migrated into the statistics payload on first run.

#### Sync & data freshness (important)

Because the plugin relies entirely on Obsidian's persistence layer, statistics now sync automatically across devices (as long as **Plugin data** is enabled in Obsidian Sync). Each modification follows a load → modify → save cycle to ensure the latest synced snapshot is used before writing.

Notes and recommendations:

- **One-time migration**: upgrading from previous versions automatically imports the legacy `.obsidian/plugins/project-memory/stats.json` file and removes it after a successful transfer.
- **Do not edit `data.json` while sync is pending**: wait for Sync to finish before making manual changes, just like any other vault file.
- **Need a schema reference?** Open `stats.json.example` instead of the live data file.

This change removes the cross-device race condition caused by the standalone `stats.json` file and keeps the statistics aligned on every device.

### Project Statistics Display

When reviewing a project, the plugin displays three colored badges next to the project title:

1. **Urgency Score Badge**: Shows the current pertinence score from the statistics payload (`data.json` → `stats` entry) with dynamic color (green → yellow → red based on urgency level)
2. **Session Score Badge**: Shows the current effective score including rotation bonus and recency penalty (purple badge)
3. **Total Time Badge**: Shows accumulated Pomodoro time spent on the project across all sessions (amber badge)

Each action (Agréable/Calme, Sous contrôle, Urgent/Stressant, Fini) adds the configured Pomodoro duration to the project's total time. The "Passer" action does not add time.

**Note**: The total time is calculated dynamically as `totalReviews × pomodoroDuration` at display time, ensuring consistency without storing redundant data.

### Statistics Visualization

The plugin provides a dedicated statistics modal accessible via the **"View project statistics"** command. This modal displays three interactive charts showing project evolution over the last 30 days:

1. **Score Evolution Chart**: Line chart showing how the real score (pertinence_score) of each project has changed over time
2. **Effective Score Chart**: Line chart showing the effective score (real score + rotation bonus) evolution for each project
3. **Daily Actions Chart**: Stacked bar chart showing the number of review actions taken per project per day

The charts are generated using Chart.js and provide interactive features like legend toggling and hover tooltips. Data is automatically interpolated for days without activity to create smooth, continuous visualizations.

**Recent improvements (v2.1.0):**
- **NEW**: Added project count selector (Top 5, Top 10, All) to filter which projects are displayed in charts and projects list based on priority score
- **IMPROVED**: Project count filter now applies to both charts and the projects priority list for consistent filtering experience
- **ENHANCED**: Dynamic title in projects list shows current filter selection (e.g., "Liste des Projets par Priorité (Top 5)")

**Previous improvements (v2.0.0):**
- Fixed scrolling issues in the statistics modal - charts now properly adapt to available space
- Optimized chart responsiveness with better CSS flexbox layout
- Enhanced chart interactivity with improved tooltips and hover effects
- Reduced chart height to 300px for better space utilization
- Charts now maintain proper aspect ratio and prevent horizontal overflow
- **NEW**: Added a colorful projects list at the bottom of the statistics modal showing all projects sorted by priority with time spent and visual indicators
- **FIXED**: Resolved Chart.js date adapter loading error (`Cannot read properties of undefined (reading '_adapters')`) by ensuring proper sequential loading of Chart.js and its date adapter
- **FIXED**: Fixed timeline chart in day mode showing empty data by replacing Chart.js time axis with regular linear axis to avoid date adapter dependency issues

### Projects Priority List

The statistics modal now includes a comprehensive projects list at the bottom that displays:

- **Project Cards**: Each project is shown in a colorful card with a unique color scheme
- **Priority Sorting**: Projects are automatically sorted by their effective score (current score + rotation bonus) in descending order
- **Time Tracking**: Shows the total time spent on each project calculated as `totalReviews × pomodoroDuration`
- **Visual Indicators**: Each card features:
  - Project name prominently displayed
  - Time spent with formatted display (minutes, hours, or days)
  - Priority score showing the effective score
  - Number of reviews completed
  - Color-coded borders and accents matching the project's chart color

The cards are arranged in a responsive grid layout that adapts to different screen sizes, with hover effects and smooth animations for an engaging user experience.

### Project Count Filter

The statistics modal now includes a project count selector that allows you to filter which projects are displayed in the charts:

- **Top 5**: Shows only the 5 projects with the highest priority scores (currentScore)
- **Top 10**: Shows the 10 most priority projects (default selection)
- **All**: Shows all projects in your vault

This filter helps focus on the most important projects when you have many projects, making the charts more readable and actionable. The filter is applied to all three charts (Score Evolution, Effective Score, and Daily Actions) and the projects priority list, updating automatically when you change the selection.

### Example Statistics File

The `stats.json.example` file shows the structure of the statistics payload that is stored under the `stats` key in `data.json`. Each project entry includes:
- `currentScore`: the current pertinence score tracked for the project
- `rotationBonus`: accumulated bonus points from other projects being worked on
- `totalReviews`: number of times this project has been reviewed
- `lastReviewDate`: ISO timestamp of the most recent review
- `reviewHistory`: array of recent actions (limited to last 100 entries)

## Troubleshooting

### Statistics not loading on plugin restart

If the total time badge shows 0 minutes after restarting Obsidian, ensure that:

1. The plugin loads statistics data at startup (fixed in recent versions)
2. The plugin data blob (`.obsidian/plugins/project-memory/data.json`) contains a `stats` entry
3. Check the browser console for any error messages during plugin initialization

**Recent fixes:**
- Statistics now load during the `onload()` phase before any review command runs
- Settings and statistics share the Obsidian-managed `data.json` file, removing custom file handling
- Empty statistics payloads are persisted immediately to seed the `stats` key
- Legacy `stats.json` data is migrated into `data.json` automatically during upgrade
- Fixed critical bug where statistics were being reset on plugin restart due to asynchronous save operations

## Testing & release

Manual install for testing:

1. Build the plugin: `npm run build`
2. Copy `main.js`, `manifest.json`, and `styles.css` to `<Vault>/.obsidian/plugins/project-memory/`
3. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

Release checklist:

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` mapping.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version` and attach `manifest.json`, `main.js`, and `styles.css`.

## Contributing

Keep `main.ts` minimal: delegate feature logic to modules in `src/`. When you add or change commands or settings, update this `README.md` accordingly.

## License

This project is licensed under the terms in `LICENSE`.