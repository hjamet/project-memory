## Contexte

Lors de l'implémentation de la fonctionnalité de priorisation des nouveaux projets avec badge "Nouveau", un bug a été introduit : les nouveaux projets restent indéfiniment dans la catégorie "nouveaux projets" car le premier clic sur un des boutons d'action (Agréable/Calme, Sous contrôle, Urgent/Stressant, Fini) ne comptabilise pas les statistiques (totalReviews reste à 0). 

Le problème est que la logique actuelle empêche l'incrémentation de `totalReviews` lors du premier clic, ce qui fait que le projet continue d'être considéré comme nouveau (totalReviews === 0) lors des prochaines sélections. Le projet ne quitte donc jamais la catégorie des nouveaux projets et reste sélectionné en priorité indéfiniment.

Au premier clic sur un des 4 boutons, le projet devrait cesser d'être considéré comme nouveau, même si les statistiques ne sont pas comptabilisées (pas d'incrémentation de totalReviews, pas d'ajout à l'historique, pas de rotation bonus).

## Objectif

Corriger le comportement pour que, lors du premier clic sur un bouton d'action, le projet cesse d'être considéré comme nouveau (même si les statistiques ne sont pas comptabilisées). Cela permettra au système de sélection de passer aux autres projets lors des prochaines reviews.

## Fichiers Concernés

### Du travail effectué précédemment :
- `src/ReviewModal.ts` : Contient la logique de sélection des projets (lignes 186-216) qui sépare les nouveaux projets (totalReviews === 0) des projets existants, et la fonction `updateScore()` (lignes 384-426) qui gère le comportement de la première review. Le problème se situe dans la logique de première review qui ne fait qu'incrémenter le score sans marquer le projet comme "non-nouveau".

### Fichiers potentiellement pertinents pour l'exploration :
- `main.ts` : Contient la structure `ProjectStats` et la méthode `getProjectStats()` qui retourne les statistiques d'un projet, incluant `totalReviews`. Il faudra peut-être ajouter un champ ou modifier la logique pour marquer qu'un projet n'est plus nouveau après le premier clic.

### Recherches à effectuer :
- Recherche sémantique : "Comment est déterminé si un projet est nouveau dans ReviewModal ?"
- Recherche sémantique : "Comment la fonction updateScore gère-t-elle la première review ?"
- Documentation : Lire `README.md` pour comprendre le système de statistiques et de reviews

### Fichiers de résultats d'autres agents (si pertinents) :
- Aucun fichier de résultat d'autres agents pour le moment

**Fichier output pour le rapport final :**
- `.cursor/agents/rapport-corriger-bug-nouveaux-projets-reste-indefiniment.md`

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

L'exploration est OBLIGATOIRE, pas optionnelle. L'agent ne doit pas supposer comment corriger le bug sans avoir lu et compris exhaustivement le code existant et le problème décrit.

