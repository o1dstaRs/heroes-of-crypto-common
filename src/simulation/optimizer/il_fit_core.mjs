const finiteLogits = (logits) => {
    if (!Array.isArray(logits) || !logits.length || logits.some((value) => !Number.isFinite(value))) {
        throw new Error("logits must be a non-empty array of finite numbers");
    }
};

export function semanticGroups(signatures) {
    if (!Array.isArray(signatures) || !signatures.length) {
        throw new Error("signatures must be a non-empty array");
    }
    const bySignature = new Map();
    for (let index = 0; index < signatures.length; index += 1) {
        const signature = signatures[index];
        if (typeof signature !== "string" || !signature) throw new Error("candidate signatures must be non-empty");
        const group = bySignature.get(signature);
        if (group) group.indices.push(index);
        else bySignature.set(signature, { signature, indices: [index] });
    }
    return [...bySignature.values()];
}

const logMeanExp = (values) => {
    const maximum = Math.max(...values);
    let sum = 0;
    for (const value of values) sum += Math.exp(value - maximum);
    return maximum + Math.log(sum / values.length);
};

export function semanticGroupDistribution(logits, signatures) {
    finiteLogits(logits);
    if (logits.length !== signatures.length) throw new Error("logits/signatures length mismatch");
    const groups = semanticGroups(signatures).map((group) => ({
        ...group,
        logit: logMeanExp(group.indices.map((index) => logits[index])),
    }));
    const maximum = Math.max(...groups.map((group) => group.logit));
    const denominator = groups.reduce((sum, group) => sum + Math.exp(group.logit - maximum), 0);
    return groups.map((group) => ({ ...group, probability: Math.exp(group.logit - maximum) / denominator }));
}

/** Duplicate-neutral semantic-group cross-entropy and its derivative with respect to candidate logits. */
export function groupedSemanticLossAndGradient(logits, signatures, targetSignature) {
    const groups = semanticGroupDistribution(logits, signatures);
    const target = groups.find((group) => group.signature === targetSignature);
    if (!target) throw new Error("target signature is absent from the candidate set");
    const gradient = new Array(logits.length).fill(0);
    for (const group of groups) {
        const memberMaximum = Math.max(...group.indices.map((index) => logits[index]));
        const memberDenominator = group.indices.reduce(
            (sum, index) => sum + Math.exp(logits[index] - memberMaximum),
            0,
        );
        const groupError = group.probability - (group.signature === targetSignature ? 1 : 0);
        for (const index of group.indices) {
            const withinGroup = Math.exp(logits[index] - memberMaximum) / memberDenominator;
            gradient[index] = groupError * withinGroup;
        }
    }
    return { loss: -Math.log(Math.max(1e-12, target.probability)), gradient, groups };
}

export function predictSemanticGroup(logits, signatures) {
    const groups = semanticGroupDistribution(logits, signatures).sort(
        (left, right) => right.probability - left.probability || left.indices[0] - right.indices[0],
    );
    return {
        signature: groups[0].signature,
        probability: groups[0].probability,
        margin: groups.length > 1 ? groups[0].probability - groups[1].probability : 1,
    };
}

/**
 * Confidence in the search's gate-adjusted semantic choice. Challenger means are reduced by the override gate;
 * when the incumbent is illegal the legal challengers retain their raw means. A boundary choice or a choice
 * forced by every other semantic group being illegal receives zero training weight.
 */
export function deriveTeacherConfidence(means, signatures, chosen, gate, tolerance = 2e-5) {
    if (!Array.isArray(means) || means.length !== signatures.length || means.length < 2) {
        throw new Error("teacher means must align with at least two candidate signatures");
    }
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= means.length) throw new Error("invalid chosen index");
    if (!Number.isFinite(gate) || gate < 0) throw new Error("gate must be non-negative");
    for (const mean of means) {
        if (mean !== null && !Number.isFinite(mean)) throw new Error("teacher means must be finite or null");
    }
    if (means[chosen] === null) throw new Error("chosen teacher candidate is illegal");
    const incumbentLegal = means[0] !== null;
    const adjusted = means.map((mean, index) => {
        if (mean === null) return -Infinity;
        if (!incumbentLegal || index === 0) return mean;
        return mean - gate;
    });
    const groups = semanticGroups(signatures).map((group) => ({
        signature: group.signature,
        score: Math.max(...group.indices.map((index) => adjusted[index])),
    }));
    const targetSignature = signatures[chosen];
    const target = groups.find((group) => group.signature === targetSignature);
    const otherScores = groups
        .filter((group) => group.signature !== targetSignature && Number.isFinite(group.score))
        .map((group) => group.score);
    const bestOther = otherScores.length ? Math.max(...otherScores) : -Infinity;
    if (!target || target.score + tolerance < bestOther) {
        throw new Error("chosen semantic group is inconsistent with gate-adjusted rollout means");
    }
    if (!Number.isFinite(bestOther)) {
        return { targetSignature, margin: null, weight: 0, forced: true };
    }
    const margin = Math.max(0, target.score - bestOther);
    const scale = Math.max(gate, 0.01);
    return { targetSignature, margin, weight: Math.min(1, margin / scale), forced: false };
}
