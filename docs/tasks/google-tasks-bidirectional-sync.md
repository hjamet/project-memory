# Google Tasks — Synchronisation Bidirectionnelle

## 1. Contexte & Discussion (Narratif)

La synchronisation Google Tasks était initialement conçue comme un pipeline "ingestion only" : une tâche créée dans Google Tasks (avec un tag `[PROJET]`) était importée dans Obsidian, puis immédiatement marquée comme "Completed" dans Google Tasks (via le paramètre `deleteTaskAfterSync`). Le but était d'éviter les doublons.

L'utilisateur a identifié que ce modèle ne correspond plus à son usage. Voici les décisions prises :

- **Le tag `[PROJET]` n'est plus utilisé.** Toutes les tâches Google Tasks sont désormais synchronisées, sans filtre.
- **La synchronisation doit être bidirectionnelle** :
  - Si une tâche est marquée *Done* dans Google Tasks → la note Obsidian correspondante est mise à jour (ou supprimée).
  - Si une note/tâche est marquée *Completed* dans Obsidian → la tâche Google Tasks correspondante est marquée comme *Done*.
- **Le paramètre `deleteTaskAfterSync` doit être supprimé.** Il n'a plus de sens dans un modèle bidirectionnel.
- **Nouveau paramètre** : `deleteNoteOnTaskComplete` (défaut : `true`). Si une tâche est marquée Done dans Google Tasks, la note Obsidian correspondante est **supprimée physiquement** du vault.
- **Mécanisme de réconciliation par polling** : À chaque cycle de synchronisation, le plugin compare l'état Google Tasks vs l'état local (notes Obsidian). Les notes manquantes sont créées, les états de complétion sont synchronisés dans les deux sens. Ce design gère naturellement les cas hors-ligne.

## 2. Fichiers Concernés

**Note : Ce travail concerne le plugin Gemini Sync, PAS project-memory.**

- Le module de synchronisation Google Tasks dans le plugin Gemini Sync (fichier(s) à identifier par semsearch).
- Les settings du plugin Gemini Sync (suppression de `deleteTaskAfterSync`, ajout de `deleteNoteOnTaskComplete`).
- Le frontmatter des notes générées (ajout d'un `g_task_id` pour le lien persistant).

## 3. Objectifs (Definition of Done)

* **Toutes les tâches** Google Tasks sont synchronisées (plus de filtre `[PROJET]`).
* La complétion est synchronisée **bidirectionnellement** : marquer Done d'un côté met à jour l'autre côté au prochain cycle de sync.
* Le setting `deleteTaskAfterSync` est supprimé du code et des settings.
* Un nouveau setting `deleteNoteOnTaskComplete` (défaut `true`) supprime la note Obsidian quand la tâche Google Tasks est marquée Done.
* Chaque note créée par la synchro porte un `g_task_id` dans son frontmatter pour maintenir le lien.
* Le système fonctionne correctement même après des périodes hors-ligne grâce au mécanisme de réconciliation par polling.
