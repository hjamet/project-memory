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
README.md            # This file
```

Key implementation files:
- `src/ReviewModal.ts`: UI and review logic for the modal used by the plugin.
- `main.ts`: plugin onload/onunload and command registration.

## Important files & commands

- **`manifest.json`**: contains `id`, `name`, `version`, and `minAppVersion`. Ensure `id` matches the plugin folder name (`project-memory`) when installing locally.
- **Developer commands** (run via command palette while developing):

```
Review a project    # opens the review modal for the selected project
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

The plugin maintains detailed statistics in a `stats.json` file located in the plugin directory (`.obsidian/plugins/project-memory/stats.json`). This file tracks:

- **Per-project data**: rotation bonus, total reviews, last review date, and review history
- **Global statistics**: total reviews across all projects and Pomodoro time
- **Review history**: detailed log of all actions taken on each project (last 100 entries per project)

The statistics file is automatically created and maintained by the plugin. You can safely delete it to reset all statistics, and it will be recreated with empty data on the next plugin use.

### Example Statistics File

The `stats.json.example` file shows the structure of the statistics data for reference. Each project entry includes:
- `rotationBonus`: accumulated bonus points from other projects being worked on
- `totalReviews`: number of times this project has been reviewed
- `lastReviewDate`: ISO timestamp of the most recent review
- `reviewHistory`: array of recent actions (limited to last 100 entries)

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