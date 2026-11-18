export const A19_REVEALED_RANGED_DRAFT_POLICY = "revealed-ranged-draft-only-20261117";
export const A19_REVEALED_RANGED_SETUP_POLICY = "revealed-ranged-setup-only-20261117";
export const A19_REVEALED_RANGED_POLICY = Object.freeze({
    id: "revealed-ranged-exclusive-delivery-v1",
    draft: A19_REVEALED_RANGED_DRAFT_POLICY,
    setup: A19_REVEALED_RANGED_SETUP_POLICY,
    dispatch: "draft-used-keeps-native-setup-otherwise-setup-eligible",
    runtime: "authoritative-ranked-and-premium",
    adoption: "explicit-user-adoption-with-uncertainty",
});
