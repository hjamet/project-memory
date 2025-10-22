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
stats.json           # Statistics data (auto-generated, ignored by Git)
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
- `defaultScore` — default pertinence score for notes without frontmatter score (default: 50)
- `archiveTag` — tag applied when marking a project as finished (default: `projet-fini`)
- `rotationBonus` — points added to all other projects when one project is worked on (default: 0.1)
- `rapprochementFactor` — fraction of remaining gap closed on each action (0..1, default: 0.2)
 - `recencyPenaltyWeight` — multiplier for the temporary per-session recency penalty applied to projects reviewed during the active session (default: 1.0). Set to `0` to disable the feature.

Settings are persisted using Obsidian's `loadData()` / `saveData()` APIs.

## Rotation Bonus System

The plugin uses a rotation-based bonus system instead of time-based bonuses. When you work on a project (click any action button except "Passer"), all other projects gain bonus points equal to the `rotationBonus` setting. This ensures that neglected projects gradually become more likely to be selected for review.

### Statistics Tracking

The plugin maintains detailed statistics in a `stats.json` file located in the plugin directory (`.obsidian/plugins/project-memory/stats.json`). This file is automatically ignored by Git (see `.gitignore`) as it contains user-specific data. The file tracks:

- **Per-project data**: rotation bonus, total reviews, last review date, total Pomodoro time, and review history
- **Global statistics**: total reviews across all projects and Pomodoro time
- **Review history**: detailed log of all actions taken on each project (last 100 entries per project)

The statistics file is automatically created and maintained by the plugin. You can safely delete it to reset all statistics, and it will be recreated with empty data on the next plugin use.

### Project Statistics Display

When reviewing a project, the plugin displays three colored badges next to the project title:

1. **Urgency Score Badge**: Shows the base pertinence score from frontmatter with dynamic color (green → yellow → red based on urgency level)
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

### Example Statistics File

The `stats.json.example` file shows the structure of the statistics data for reference. Each project entry includes:
- `rotationBonus`: accumulated bonus points from other projects being worked on
- `totalReviews`: number of times this project has been reviewed
- `lastReviewDate`: ISO timestamp of the most recent review
- `reviewHistory`: array of recent actions (limited to last 100 entries)

## Troubleshooting

### Statistics not loading on plugin restart

If the total time badge shows 0 minutes after restarting Obsidian, ensure that:

1. The plugin loads statistics data at startup (fixed in recent versions)
2. The `stats.json` file exists in the plugin directory
3. Check the browser console for any error messages during plugin initialization

**Recent fixes:**
- The plugin now automatically loads statistics data during the `onload()` phase
- The plugin directory is created automatically if it doesn't exist
- Statistics are saved synchronously when the plugin unloads to prevent data loss
- Empty statistics are saved immediately to create the initial `stats.json` file
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