# Obsidian Sample Plugin

This is a sample plugin for Obsidian (https://obsidian.md).

This project uses TypeScript to provide type checking and documentation.
The repo depends on the latest plugin API (obsidian.d.ts) in TypeScript Definition format, which contains TSDoc comments describing what it does.

This sample plugin demonstrates some of the basic functionality the plugin API can do.
- Adds a ribbon icon, which shows a Notice when clicked.
- Adds a command "Open Sample Modal" which opens a Modal.
- Adds a plugin setting tab to the settings page.
- Registers a global click event and output 'click' to the console.
- Registers a global interval which logs 'setInterval' to the console.

## First time developing plugins?

Quick starting guide for new plugin devs:

- Check if [someone already developed a plugin for what you want](https://obsidian.md/plugins)! There might be an existing plugin similar enough that you can partner up with.
- Make a copy of this repo as a template with the "Use this template" button (login to GitHub if you don't see it).
- Clone your repo to a local development folder. For convenience, you can place this folder in your `.obsidian/plugins/your-plugin-name` folder.
- Install NodeJS, then run `npm i` in the command line under your repo folder.
- Run `npm run dev` to compile your plugin from `main.ts` to `main.js`.
- Make changes to `main.ts` (or create new `.ts` files). Those changes should be automatically compiled into `main.js`.
- Reload Obsidian to load the new version of your plugin.
- Enable plugin in settings window.
- For updates to the Obsidian API run `npm update` in the command line under your repo folder.

## Releasing new releases

- Update your `manifest.json` with your new version number, such as `1.0.1`, and the minimum Obsidian version required for your latest release.
- Update your `versions.json` file with `"new-plugin-version": "minimum-obsidian-version"` so older versions of Obsidian can download an older version of your plugin that's compatible.
- Create new GitHub release using your new version number as the "Tag version". Use the exact version number, don't include a prefix `v`. See here for an example: https://github.com/obsidianmd/obsidian-sample-plugin/releases
- Upload the files `manifest.json`, `main.js`, `styles.css` as binary attachments. Note: The manifest.json file must be in two places, first the root path of your repository and also in the release.
- Publish the release.

> You can simplify the version bump process by running `npm version patch`, `npm version minor` or `npm version major` after updating `minAppVersion` manually in `manifest.json`.
> The command will bump version in `manifest.json` and `package.json`, and add the entry for the new version to `versions.json`

## Adding your plugin to the community plugin list

- Check the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Publish an initial version.
- Make sure you have a `README.md` file in the root of your repo.
- Make a pull request at https://github.com/obsidianmd/obsidian-releases to add your plugin.

## How to use

- Clone this repo.
- Make sure your NodeJS is at least v16 (`node --version`).
- `npm i` or `yarn` to install dependencies.
- `npm run dev` to start compilation in watch mode.

### Review command and settings

- **Command**: use the command palette and run `Review a project` (or click the ribbon icon) to start an adaptive review loop that selects projects for review.
- **Settings added**:
  - **`defaultScore`**: default pertinence score used when a project has no `pertinence_score` in frontmatter (default: `50`).
  - **`archiveTag`**: tag applied when marking a project as finished (default: `projet-fini`).
  - **`ageBonusPerDay`**: additive linear bonus added per day since last review (default: `1`).
  - **`rapprochementFactor`**: fraction of the remaining gap closed on each click (0..1, default: `0.2`).

- **Behavior & context**: when the review modal opens, the chosen project file is opened in the currently active editor pane to provide context (no new pane is created). The modal also *remembers* the last shown project: if you close and reopen the modal, it will show the same project until you perform a review action (e.g., "Moins souvent", "Fini"), at which point the remembered project is reset and a new one will be selected on the next open.

Note on recent fixes:

- **Ribbon icon**: the left ribbon icon now opens the same review modal as the `Review a project` command (previously it printed results to the console).
- **Tags suggestions in settings**: the tag picker in the settings uses a non-blocking dropdown attached to the input field (type-ahead), instead of a blocking modal.
- **Review modal**: added numeric keyboard shortcuts (`1`–`5`) for the five review actions (Moins souvent, Fréquence OK, Plus souvent, Priorité Max, Fini); shortcuts are active only while the modal is open.
- **Tags suggestor behavior**: the tag suggestion dropdown now closes automatically after selecting a suggestion, keeping focus in the input.

The review modal updates `pertinence_score` and frontmatter fields when actions are performed.

Note on styling: CSS rules were recently scoped to the review modal to avoid leaking styles into the rest of Obsidian. Files modified: `src/ReviewModal.ts` (adds `.projects-memory-review-modal` class) and `styles.css` (all selectors prefixed with `.projects-memory-review-modal`, button min-width removed, `flex-wrap` added to `.review-buttons`).