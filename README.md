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
- `ageBonusPerDay` — linear bonus added per day since last review (default: 1)
- `rapprochementFactor` — fraction of remaining gap closed on each action (0..1, default: 0.2)

Settings are persisted using Obsidian's `loadData()` / `saveData()` APIs.

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