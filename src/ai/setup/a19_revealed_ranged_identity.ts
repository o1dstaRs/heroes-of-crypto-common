export const A19_REVEALED_RANGED_DRAFT_POLICY = "revealed-ranged-draft-only-20261117";
export const A19_REVEALED_RANGED_SETUP_POLICY = "revealed-ranged-setup-only-20261117";
export const A19_SNIPER_DONOR_POLICY = Object.freeze({
    id: "sniper-donor-preservation-v1",
    checkpoint: "a19-preserve-sniper-20261118",
    evidenceSha256: "f5f66841fed30cb98dabd955c6f5024e3c880db92e01a817c05500707b0fdb59",
    dispatch: "public-complete-native-sniper2plus-unused-delivery-budget",
    runtime: "authoritative-ranked-and-premium",
    adoption: "qualified-policy-explicit-user-adoption",
});
export const A19_REVEALED_RANGED_POLICY = Object.freeze({
    id: "revealed-ranged-exclusive-delivery-v1",
    draft: A19_REVEALED_RANGED_DRAFT_POLICY,
    setup: A19_REVEALED_RANGED_SETUP_POLICY,
    dispatch: "draft-used-keeps-native-setup-otherwise-setup-eligible",
    runtime: "authoritative-ranked-and-premium",
    adoption: "explicit-user-adoption-with-uncertainty",
});
