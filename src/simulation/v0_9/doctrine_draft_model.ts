/*
 * Compat path only (2026-11-26). The v0.9 AI and the A19 neural correction were removed; the locked doctrine draft
 * moved to a non-v0.9 home. Sealed research helpers (contextual draft, Empower, ranged counter) pin their own source
 * sha256 in immutable checkpoints, so their import paths cannot change: this module re-exports the moved code and
 * holds nothing else. New code imports the new path.
 */
export * from "../../ai/setup/doctrine_draft/doctrine_draft_model";
