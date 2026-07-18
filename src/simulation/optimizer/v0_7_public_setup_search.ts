/* Establish the promotion-grade environment before any AI or fight module is imported. */

const REQUIRED_RESEARCH_ENV = {
    LIVETWIN: "1",
    V07_SEARCH: "0",
} as const;

const BEHAVIOR_ENV_KEY =
    /^(?:V0\d_|SEARCH_|Q2_|FIGHT_MELEE_ROSTERS$|FORCE_CREATURES$|ROSTER_|LIVETWIN$|SIM_NO_ACTIONS$|COHORT$|VALUE_DATA|PHASE_B_RUN_FINGERPRINT$|HOC_DRAFT_WEIGHTS$)/;

export const PUBLIC_SETUP_BOOTSTRAP_MARKER = "HOC_PUBLIC_SETUP_SANITIZED";

export function bootstrapPublicSetupEnvironment(): Record<string, string> {
    for (const [key, value] of Object.entries(process.env)) {
        if (!BEHAVIOR_ENV_KEY.test(key)) continue;
        const required = REQUIRED_RESEARCH_ENV[key as keyof typeof REQUIRED_RESEARCH_ENV];
        if (required === undefined) throw new Error(`unsafe behavior-affecting environment variable ${key}`);
        if (value !== required) throw new Error(`unsafe ${key}=${JSON.stringify(value)}; required ${required}`);
    }
    for (const [key, value] of Object.entries(REQUIRED_RESEARCH_ENV)) process.env[key] = value;
    delete process.env.SIM_NO_ACTIONS;
    process.env[PUBLIC_SETUP_BOOTSTRAP_MARKER] = "1";
    return { ...REQUIRED_RESEARCH_ENV, SIM_NO_ACTIONS: "<unset>" };
}

export async function main(): Promise<void> {
    bootstrapPublicSetupEnvironment();
    const runner = await import("./v0_7_public_setup_search_runner");
    await runner.main();
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
