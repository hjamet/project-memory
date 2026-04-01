# Stats Sidebar View — Vue latérale pour les statistiques de projets

## 1. Contexte & Discussion (Narratif)
L'utilisateur dispose actuellement d'un `StatsModal` (fenêtre modale) qui affiche les statistiques de ses projets : liste de cartes de projets triées par priorité, graphiques Chart.js (score effectif, actions par jour), recherche Levenshtein, contrôles dynamiques (+/- jours, +/- projets), bouton urgence, et bouton d'ouverture de note.

Le problème : ce modal est une fenêtre éphémère. L'utilisateur souhaite pouvoir consulter ces statistiques **en permanence** dans une **sidebar Obsidian** (panneau latéral droit ou gauche). La sidebar étant en format **portrait étroit** (≈ 300-400px de large), l'interface doit être **repensée pour le mobile/portrait** : cartes empilées verticalement, graphiques plus compacts, contrôles adaptés.

La session actuelle a également corrigé deux points dans le `StatsModal` existant :
- **Filtrage des projets archivés** : Les projets portant le tag d'archive (par défaut `#projet-fini`) étaient affichés dans les stats. Correction appliquée via `getAllTags()` + filtrage dans `processStatsData()` et `calculateProjectStats()`.
- **Bouton "Ouvrir la note"** (📄) : Ajouté sur chaque carte projet pour naviguer directement vers le fichier.

Ces deux corrections sont déjà intégrées dans le `StatsModal.ts` actuel et doivent être **reprises** dans la nouvelle sidebar view.

## 2. Fichiers Concernés
- `src/StatsModal.ts` — Contient toute la logique actuelle (replay des scores, Levenshtein, Chart.js, cartes projets, filtrage archive, bouton ouvrir note). C'est la **référence** pour la logique métier à réutiliser.
- `main.ts` — Point d'entrée du plugin. C'est ici qu'il faudra enregistrer la nouvelle `ItemView` Obsidian via `registerView()` et ajouter une commande/ribbon pour l'ouvrir.
- `styles.css` — Contient tous les styles actuels scopés sous `.projects-memory-stats-modal`. Il faudra ajouter des styles équivalents scopés pour la sidebar (ex: `.projects-memory-stats-view`), optimisés portrait.

## 3. Objectifs (Definition of Done)
* **Une `ItemView` Obsidian** (classe héritant de `ItemView`) qui s'affiche dans les sidebars d'Obsidian (right leaf par défaut).
* **Contenu identique au `StatsModal`** : liste de projets (cartes), graphiques Chart.js, recherche, contrôles dynamiques, bouton urgence, bouton ouvrir note, filtrage des projets archivés.
* **Layout optimisé portrait/narrow** : Les cartes de projets doivent s'empiler en colonne unique. Les graphiques doivent avoir une hauteur réduite adaptée à l'espace étroit. Les contrôles doivent rester utilisables dans un espace de ≈ 300px de large.
* **Commande Obsidian** pour ouvrir/fermer la sidebar view (ex: "Toggle project statistics sidebar").
* **Persistance** : La vue doit survivre au rechargement d'Obsidian (workspace serialization via `getViewType()`).
* **Pas de régression** : Le `StatsModal` existant doit continuer à fonctionner indépendamment.
