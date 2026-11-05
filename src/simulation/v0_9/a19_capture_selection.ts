/** Research data selection only; importing this module installs no engine hooks. */
export type A19CapturePhase = 0 | 1 | 2;

export interface IA19CaptureRoot {
    actor: string;
    team: number;
    lap: number;
    ordinal: number;
}

export interface IA19CaptureRequest {
    focal?: string;
    team: number;
    phase: A19CapturePhase;
}

export type A19MissingRootReason =
    "focal_absent_from_draft" | "no_focal_turn" | "no_eligible_primary_tie" | "no_eligible_root_in_requested_phase";

export function a19CapturePhase(lap: number): A19CapturePhase {
    if (!Number.isInteger(lap) || lap < 1) throw new RangeError("Invalid battle lap");
    return lap <= 2 ? 0 : lap <= 5 ? 1 : 2;
}

/** Ranking is provided by the caller's registered outcome-blind hash. */
export class A19StrictRootCollector<T extends IA19CaptureRoot> {
    private chosen: (T & { rank: number; priority: 0; focalPresentAtRoot: true }) | null = null;
    private focalDecisions = 0;
    private eligibleDecisions = 0;
    private readonly phases = [0, 0, 0];
    private readonly request: Readonly<IA19CaptureRequest>;
    public constructor(request: IA19CaptureRequest) {
        if (![0, 1, 2].includes(request.phase) || !Number.isInteger(request.team))
            throw new RangeError("Invalid capture request");
        if (request.focal !== undefined && !request.focal.trim()) throw new RangeError("Empty focal unit");
        this.request = Object.freeze({ ...request });
    }
    public noteDecision(actor: string, team: number, lap: number, eligible: boolean): void {
        const phase = a19CapturePhase(lap);
        if (!this.matches(actor, team)) return;
        this.focalDecisions++;
        if (eligible) {
            this.eligibleDecisions++;
            this.phases[phase]++;
        }
    }
    public offer(root: T, rank: number): void {
        const phase = a19CapturePhase(root.lap);
        if (!Number.isInteger(rank) || rank < 0 || rank > 0xffffffff) throw new RangeError("Invalid root rank");
        if (!Number.isInteger(root.ordinal) || root.ordinal < 0) throw new RangeError("Invalid root ordinal");
        if (!this.matches(root.actor, root.team) || phase !== this.request.phase) return;
        if (
            !this.chosen ||
            rank < this.chosen.rank ||
            (rank === this.chosen.rank && root.ordinal < this.chosen.ordinal)
        )
            this.chosen = { ...root, rank, priority: 0, focalPresentAtRoot: true };
    }
    public selected(): (T & { rank: number; priority: 0; focalPresentAtRoot: true }) | null {
        return this.chosen;
    }
    public finish(ownRosterNames: readonly string[]) {
        const present = !this.request.focal || ownRosterNames.includes(this.request.focal);
        if (this.chosen && !present) throw new Error("Selected focal root contradicts draft roster");
        const reason: A19MissingRootReason | null = this.chosen
            ? null
            : !present
              ? "focal_absent_from_draft"
              : this.focalDecisions === 0
                ? "no_focal_turn"
                : this.eligibleDecisions === 0
                  ? "no_eligible_primary_tie"
                  : "no_eligible_root_in_requested_phase";
        return {
            requestedPhase: this.request.phase,
            selectedPhase: this.chosen ? a19CapturePhase(this.chosen.lap) : null,
            focalPresentAtDraft: present,
            focalDecisions: this.focalDecisions,
            eligibleFocalDecisions: this.eligibleDecisions,
            eligibleFocalDecisionsByPhase: [...this.phases],
            missingRootReason: reason,
        };
    }
    private matches(actor: string, team: number): boolean {
        return team === this.request.team && (!this.request.focal || actor === this.request.focal);
    }
}
