function calculateEffectiveScore(baseScore, rotationBonus, deadline, count, rapprochment, weight) {
    let effectiveScore = baseScore;
    effectiveScore += rotationBonus;

    if (deadline) {
        const deadlineDate = new Date(deadline);
        if (!isNaN(deadlineDate.getTime())) {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const deadlineDay = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());
            const diffTime = deadlineDay.getTime() - today.getTime();
            const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            let factor = 1.0;
            if (daysRemaining > 0) {
                factor = Math.exp(-0.1 * daysRemaining);
            }

            const gap = 100 - effectiveScore;
            if (gap > 0) {
                effectiveScore += gap * factor;
            }
        }
    }

    if (count > 0) {
        const totalMultiplier = count * weight;
        const integerPart = Math.floor(totalMultiplier);
        const fractionalPart = totalMultiplier - integerPart;
        for (let i = 0; i < integerPart; i++) {
            const perte = rapprochment * (effectiveScore - 1);
            effectiveScore = effectiveScore - perte;
        }
        if (fractionalPart > 0) {
            const finalPerte = rapprochment * (effectiveScore - 1);
            effectiveScore -= finalPerte * fractionalPart;
        }
    }
    return Math.round(effectiveScore);
}

console.log("No deadline:", calculateEffectiveScore(47, 5, null, 0, 0.2, 0.5));
console.log("Passed deadline:", calculateEffectiveScore(47, 5, "2024-01-01", 0, 0.2, 0.5));
console.log("Future deadline (10 days):", calculateEffectiveScore(47, 5, new Date(Date.now() + 10*86400*1000).toISOString(), 0, 0.2, 0.5));
