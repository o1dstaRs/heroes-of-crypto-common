export const A19_LEARNED_FINAL_PLACEMENT_V1_POLICY = Object.freeze({
    id: "a19-authoritative-final-placement-v1" as const,
    modelId: "free-placement-fit-0" as const,
    exportSha256: "3aa76b4c37ee49c99cab212a5a5f8f90020580f493300b61fb9e4af1bc554590" as const,
    minimumGain: 0.03,
    candidateCount: 8,
    applicationStage: "after-authoritative-final-formation-before-barrels" as const,
    informationRequirement: "own-setup-and-public-opponent-roster" as const,
    adoption: "user-authorized-with-inconclusive-strength" as const,
    registeredStrengthGatePassed: false,
});

export const V09_LEARNED_FINAL_PLACEMENT_POLICY = Object.freeze({
    id: "a19-authoritative-final-placement-v2" as const,
    generation: "v0.9" as const,
    modelId: "relations-v2-absolute-256" as const,
    exportSha256: "4bb2199fb9af3212a17dfaef6d73de14fb174f1c4ff8699eda96c3a4a2a3554a" as const,
    referenceModelId: A19_LEARNED_FINAL_PLACEMENT_V1_POLICY.modelId,
    referenceExportSha256: A19_LEARNED_FINAL_PLACEMENT_V1_POLICY.exportSha256,
    featureSchema: "placement-role-relations-v2" as const,
    minimumGain: 0.03,
    candidateCount: 8,
    applicationStage: "after-authoritative-final-formation-before-barrels" as const,
    informationRequirement: "own-setup-and-public-opponent-roster" as const,
    adoption: "user-authorized-after-independent-confirmation" as const,
    registeredStrengthGatePassed: true,
    confirmationRegistrationSha256: "a613ca1f0c346f21d0d8e09edddac288eefcfaca01d492173809ba32ac5e3f91" as const,
});

export const A19_LEARNED_FINAL_PLACEMENT_POLICY = V09_LEARNED_FINAL_PLACEMENT_POLICY;
