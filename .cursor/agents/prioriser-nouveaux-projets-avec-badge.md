## Contexte

Lors de l'analyse du système de revue de projets dans le plugin Obsidian Projects Memory, il a été identifié que les nouveaux projets (projets sans historique de review, `totalReviews === 0`) ne bénéficient pas d'une priorisation spéciale lors des séances de revue. Actuellement, les projets sont sélectionnés uniquement selon leur `effectiveScore` (score de pertinence + bonus de rotation), ce qui peut faire que des projets nouveaux mais avec un score par défaut ne soient pas prioritaires.

De plus, il n'existe pas d'indicateur visuel pour identifier facilement les nouveaux projets lors de l'affichage dans la modale de revue. L'ajout d'un badge orange "Nouveau" permettrait aux utilisateurs de reconnaître immédiatement les projets qui n'ont jamais été revus.

## Objectif

Modifier le système de sélection et d'affichage des projets dans la modale de revue pour :
1. Prioriser les nouveaux projets (projets avec `totalReviews === 0`) en les présentant en premier lors des séances de revue
2. Ajouter un badge orange "Nouveau" pour identifier visuellement les projets qui n'ont jamais été revus

L'implémentation doit respecter la logique existante de calcul du `effectiveScore` tout en ajoutant une priorité supplémentaire pour les nouveaux projets.

## Fichiers Concernés

### Du travail effectué précédemment :
- `src/ReviewModal.ts` : Contient la logique de sélection des projets candidats (lignes 143-187) et l'affichage des badges (lignes 214-244). Le tri actuel sélectionne le projet avec le `effectiveScore` le plus élevé sans prioriser les nouveaux projets.
- `main.ts` : Contient la structure `ProjectStats` avec le champ `totalReviews` (lignes 19-29) et la méthode `getProjectStats` (lignes 193-207) qui retourne les statistiques d'un projet, incluant `totalReviews`.
- `styles.css` : Contient les styles pour les badges existants (`pm-stat-badge`, `pm-badge-urgency`, `pm-badge-session`, `pm-badge-time`). Il faudra ajouter un style pour le badge "Nouveau" orange.

### Fichiers potentiellement pertinents pour l'exploration :
- `README.md` : Documente le système de badges existants (lignes 101-109) et explique comment les projets sont sélectionnés pour la revue.
- `src/StatsModal.ts` : Peut contenir des informations sur la structure des statistiques et l'affichage des projets.

### Recherches à effectuer :
- Recherche sémantique : "Comment sont triés et sélectionnés les projets candidats dans ReviewModal ?"
- Recherche sémantique : "Comment sont affichés les badges dans la modale de revue ?"
- Documentation : Lire `README.md` pour comprendre le système de scoring et de priorisation existant

### Fichiers de résultats d'autres agents (si pertinents) :
- Aucun fichier de résultat d'autres agents pour le moment

**Fichier output pour le rapport final :**
- `.cursor/agents/rapport-prioriser-nouveaux-projets-avec-badge.md`

## Instructions de Collaboration

**CRITIQUE - OBLIGATOIRE ET IMPÉRATIF** : Cette section doit être extrêmement directive et impérative. Tu DOIS spécifier que l'agent :

- **EST INTERDIT** de commencer à implémenter quoi que ce soit immédiatement
- **DOIT** lire EXHAUSTIVEMENT tous les fichiers listés dans "Fichiers Concernés" avant toute action
- **DOIT** effectuer toutes les recherches sémantiques mentionnées
- **DOIT** lire le README et toute documentation pertinente
- **DOIT** atteindre une compréhension approfondie du contexte et du projet avant toute discussion
- **DOIT** discuter avec l'utilisateur pour clarifier les attentes précises, poser des questions sur les contraintes techniques, et établir un plan d'action détaillé ensemble
- **DOIT TOUJOURS** créer le fichier de rapport final dans le fichier output mentionné après avoir terminé (voir section "Instructions pour les Rapports Finaux")
- Seulement APRÈS avoir complété cette exploration exhaustive et cette planification collaborative, peut commencer toute implémentation

L'exploration est OBLIGATOIRE, pas optionnelle. L'agent ne doit pas supposer comment fonctionne le tri actuel ou comment ajouter le badge sans avoir lu et compris exhaustivement le code existant.

