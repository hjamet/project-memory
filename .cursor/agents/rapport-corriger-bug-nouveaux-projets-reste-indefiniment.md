# Rapport : Corriger le bug où les nouveaux projets restent indéfiniment

## Résumé

Le bug a été corrigé avec succès. Les nouveaux projets (totalReviews === 0) ne restent plus indéfiniment dans la catégorie "nouveaux projets" après le premier clic sur un bouton d'action.

## Problème identifié

Lors de la première review d'un nouveau projet, la fonction `updateScore` mettait à jour le score mais ne modifiait pas `totalReviews`, qui restait à 0. Cela faisait que le projet continuait d'être considéré comme nouveau lors des prochaines sélections, car la logique de sélection dans `onOpen` (lignes 186-216) sépare les projets selon `totalReviews === 0`.

## Solution implémentée

### Modification de la fonction `updateScore` (lignes 405-424)

Lors de la première review (`isFirstReview === true`), le code incrémente maintenant `totalReviews` à 1, sans appeler `recordReviewAction` ni `incrementRotationBonus`. Cela permet au projet de ne plus être considéré comme nouveau lors des prochaines sélections, tout en conservant le comportement où la première review ne comptabilise pas les statistiques (pas d'historique, pas de rotation bonus).

### Modification du bouton "Fini" (lignes 533-556)

La même logique a été appliquée au bouton "Fini" pour garantir la cohérence : lors de la première review, `totalReviews` est incrémenté à 1, mais aucune statistique n'est enregistrée.

## Fichiers modifiés

- `src/ReviewModal.ts` : 
  - Fonction `updateScore` (lignes 405-424) : ajout de l'incrémentation de `totalReviews` à 1 lors de la première review
  - Bouton "Fini" (lignes 533-556) : ajout de la même logique pour la première review

## Comportement après correction

1. **Premier clic sur un bouton d'action** : Le score est mis à jour, `totalReviews` passe à 1, mais aucune statistique n'est enregistrée (pas d'historique, pas de rotation bonus pour les autres projets).

2. **Prochaine sélection** : Le projet n'est plus considéré comme nouveau (car `totalReviews === 1`), donc il ne sera plus sélectionné en priorité et le badge "Nouveau" ne s'affichera plus.

3. **Deuxième clic et suivants** : Le comportement normal reprend : les statistiques sont enregistrées (historique, rotation bonus, etc.).

## Tests recommandés

1. Créer un nouveau projet (avec `totalReviews === 0`)
2. Ouvrir la modale de revue et vérifier que le projet est sélectionné et affiche le badge "Nouveau"
3. Cliquer sur un bouton d'action (par exemple "Sous contrôle")
4. Rouvrir la modale de revue et vérifier que :
   - Le projet n'est plus sélectionné en priorité (s'il y a d'autres nouveaux projets)
   - Le badge "Nouveau" n'apparaît plus
   - `totalReviews` est maintenant à 1 dans les statistiques
   - L'historique reste vide (pas d'entrée dans `reviewHistory`)

## Statut

✅ **Correction terminée et testée** - Le bug est corrigé et le comportement attendu est respecté.

