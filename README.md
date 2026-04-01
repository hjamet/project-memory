# Projects Memory — Obsidian plugin

Projects Memory is an Obsidian community plugin that helps you run lightweight, adaptive reviews of project notes inside your vault. It opens a review modal, suggests projects to review, updates frontmatter scores, and offers quick actions (e.g., deprioritize, archive). The plugin visualizes your progress via a powerful statistics modal using Chart.js, and provides a **permanent sidebar view** for always-on project monitoring.

# Installation

- **Node.js** (LTS recommended, Node 18+)
- Install dependencies: `npm install`
- Development (watch + build): `npm run dev`
- Production build: `npm run build`

After building, copy `main.js`, `manifest.json`, and `styles.css` to your vault under `/.obsidian/plugins/project-memory/` to test the plugin.

# Description détaillée

## Cœur du système & Actions
Le plugin repose sur un **système de bonus de rotation** : chaque fois que vous travaillez sur un projet, tous les autres projets ignorés accumulent un bonus (`rotationBonus`), garantissant mathématiquement que les projets négligés finissent par remonter à la surface.
Les actions disponibles lors d'une session de revue mettent à jour un **Score Effectif** (Score réel + Bonus) et ajoutent automatiquement du temps de travail ("Pomodoros") aux statistiques.

## Modal de Statistiques (Visualisation)
Accessible via la commande "View project statistics", le modal affiche une interface dynamique pour visualiser les performances :
- **Algorithme de Levenshtein** : Barre de recherche persistante propulsée par un algorithme de Levenshtein qui trie intelligemment les projets (les correspondances exactes s'affichent en premier, suivies des projets les plus proches phonétiquement/typographiquement).
- **Contrôles Dynamiques Multiplicateurs (+/-)** : Des boutons réactifs situés sous chaque graphique et liste permettent de cibler finement la période temporelle étudiée (ex: 10, 20, 40 jours) ou de limiter dynamiquement le nombre de courbes (ex: Top 5, 10, 20).
- **Interaction et Urgence** : Clic sur une carte pour isoler sa courbe, bouton "Urgence" (🚨) injectant un bonus pur immédiat sans compter comme une session de revue (ne réinitialise pas le bonus de séniorité).

## Sidebar de Statistiques (Vue permanente)
Accessible via la commande "Toggle project statistics sidebar", cette `ItemView` Obsidian s'ouvre dans le panneau latéral droit. Elle offre **exactement les mêmes fonctionnalités** que le modal (cartes projets, graphiques Chart.js, recherche Levenshtein, contrôles dynamiques, urgence, ouverture de note) mais avec un **layout portrait compact** optimisé pour un espace étroit (~300-400px). La sidebar se **rafraîchit automatiquement** après chaque action de review.

## Architecture : Module Partagé (`statsUtils.ts`)
Toute la logique métier (replay des scores, Levenshtein, filtrage archive, bonus deadline, génération de couleurs, formatage du temps) est centralisée dans `src/statsUtils.ts`. Ce module est importé par le `StatsModal` (plein écran) et le `StatsView` (sidebar), éliminant toute duplication de code.

## Gestion des Données (data.json)
Le plugin utilise exclusivement la mécanique interne d'Obsidian (`saveData`/`loadData`) pour enregistrer à la fois les **Paramètres** et les **Statistiques** sous la forme d'un blob synchronisé (`data.json` → `stats`). Ce choix architectural résout nativement les problèmes de race condition d'Obsidian Sync.

# Principaux résultats

- Refonte complète de l'interface des statistiques (graphiques et liste entrelacés, cartes de projets interactives).
- **Sidebar permanente** : Vue `ItemView` dans le panneau latéral avec layout portrait compact et auto-refresh.
- **Module partagé** : Extraction de ~500 lignes de logique métier dans `statsUtils.ts` (zéro duplication).
- Filtrage des projets archivés dans le `StatsModal` et ajout d'un bouton direct pour ouvrir la note depuis la liste.
- Migration réussie et suppression de l'ancien fichier `stats.json` standalone.
- Stabilité garantie des rendus Chart.js qui se recréent adéquatement à la volée.

# Documentation Index

| Titre (Lien) | Description |
|--------------|-------------|
| [Stats Modal Logic](docs/index_stats.md) | Historique et structure du Modal de Statistiques |

# Plan du repo

```text
src/                 # TypeScript source (modal, sidebar view, shared utils)
  StatsModal.ts      # Full-screen statistics modal
  StatsView.ts       # Sidebar ItemView for permanent stats
  statsUtils.ts      # Shared business logic (replay, Levenshtein, etc.)
  ReviewModal.ts     # Review modal (project selection & scoring)
docs/                # Documentation technique détaillée
main.ts              # Plugin entry: lifecycle & command registration
manifest.json        # Plugin manifest (id, name, version, minAppVersion)
styles.css           # Plugin styles scoped to modal, sidebar & controls
esbuild.config.mjs   # Build configuration
stats.json.example   # Reference structure for the statistics payload
```

# Scripts d'entrée principaux

| Commande | Explication |
|----------|-------------|
| `Review a project` | Ouvre le modal principal de revue des projets (ReviewModal) |
| `View project statistics` | Ouvre le tableau de bord analytique interactif (StatsModal plein écran) |
| `Toggle project statistics sidebar` | Ouvre/ferme la sidebar de statistiques dans le panneau latéral droit |

# Scripts exécutables secondaires & Utilitaires

| Commande NPM | Effet |
|--------------|-------|
| `npm run dev` | Lance esbuild en mode watch pour le développement continu |
| `npm run build` | Compile l'application pour la production (`main.js`) |

# Roadmap

- [Google Tasks — Synchronisation Bidirectionnelle](docs/tasks/google-tasks-bidirectional-sync.md) : Remplacer l'ingestion one-way par une synchro 2-ways complète (complétion bidirectionnelle, suppression du tag `[PROJET]`, nouveau setting `deleteNoteOnTaskComplete`).
- ~~[Stats Sidebar View](docs/tasks/stats-sidebar-view.md) : Créer une `ItemView` Obsidian permanente dans la sidebar~~ ✅ **Implémenté**
- Intégration prochaine de sous-catégories pour séparer les Projets des "Tâches One-Shot".
- Améliorer l'accessibilité du modal de statistiques.