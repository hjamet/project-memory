# Ajustement de Score vs Session de Revue

Ce document détaille la distinction technique entre une mise à jour de score (ajustement de priorité) et une session de revue (travail effectué).

## 1. Distinction Conceptuelle

- **Session de Revue** : L'utilisateur a passé du temps sur le projet. 
    - Le `rotationBonus` est remis à 0 (le projet est considéré comme "frais").
    - Le compteur `totalReviews` est incrémenté.
    - Le temps global est mis à jour.
- **Ajustement de Score** : L'utilisateur change la priorité du projet sans nécessairement y travailler.
    - Le score est mis à jour.
    - Le changement est enregistré dans `reviewHistory` pour la cohérence des graphiques.
    - **Le `rotationBonus` n'est PAS réinitialisé** (le projet conserve son accumulation de séniorité).
    - Les compteurs de revues restents inchangés.

## 2. Implémentation technique

La fonction `recordReviewAction` dans `main.ts` accepte désormais un paramètre `isReview` surchargé à `true` par défaut.

```typescript
async recordReviewAction(filePath: string, action: string, scoreAfter: number, isReview = true)
```

### Cas d'usage : Bouton Urgence (🚨)
Le bouton 🚨 dans le `StatsModal` utilise `isReview = false`. 
Action : `emergency`.

### Cas d'usage : Review Modal (Sans travail)
Si l'utilisateur sélectionne un sentiment mais répond "Non" à la question "As-tu travaillé dessus ?", le score est mis à jour en base et dans l'historique via `isReview = false`.
