import typescriptPlugin from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import globals from "globals";

/**
 * A unit's stored geometry is the CENTRE of its W x H block, and its identity on the board is the ANCHOR
 * (the top-right cell). `getCellForPosition(gs, unit.getPosition())` names the cell that centre falls in,
 * which IS the anchor only while both sides are at most 2 — for a 2x1 / 1x2 merely because the centre lands
 * exactly on a cell boundary and `floor` breaks the tie towards the anchor. A body three cells deep centres
 * on its MIDDLE cell, so the shortcut silently returns the wrong cell.
 *
 * That reads so naturally as "the unit's cell" that it was written independently in a dozen places across
 * the engine, the server and the client, and every one of them had to be found and fixed by hand. This rule
 * is the guard: ask the unit for `getBaseCell()`, or convert explicitly with
 * `GridMath.getFootprintAnchorForPosition(gs, position, width, height)`.
 */
const FOOTPRINT_GEOMETRY_RESTRICTIONS = [
    {
        selector:
            "CallExpression[callee.property.name='getCellForPosition'] > CallExpression.arguments[callee.property.name='getPosition']",
        message:
            "A unit's position is its footprint CENTRE, not its anchor cell. Use unit.getBaseCell() (or GridMath.getFootprintAnchorForPosition) so a body deeper than 2 cells resolves to the right cell.",
    },
    {
        selector:
            "CallExpression[callee.name='getCellForPosition'] > CallExpression.arguments[callee.property.name='getPosition']",
        message:
            "A unit's position is its footprint CENTRE, not its anchor cell. Use unit.getBaseCell() (or getFootprintAnchorForPosition) so a body deeper than 2 cells resolves to the right cell.",
    },
];

export default [
    {
        files: ["src/**/*.ts", "test/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
        ignores: ["scripts/**/*.js", "src/generated/**/*.{ts,js}"],
        plugins: {
            "@typescript-eslint": typescriptPlugin,
        },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            parser: typescriptParser,
            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.node,
                Bun: "readonly",
                console: "readonly",
                expect: "readonly",
                describe: "readonly",
                it: "readonly",

                // ── DOM globals used by CustomEventSource ──
                EventListener: "readonly",
                navigator: "readonly",
                EventSource: "readonly",
                // (add any other DOM APIs you use)
            },
        },
        rules: {
            ...typescriptPlugin.configs.recommended.rules,

            "selector-id-pattern": "off",
            "max-classes-per-file": "off",
            "no-useless-constructor": "off",
            "@typescript-eslint/no-parameter-properties": "off",
            "new-cap": "off",
            "@typescript-eslint/naming-convention": "off",
            "no-bitwise": "off",
            "no-multi-assign": "off",
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-useless-constructor": "error",
            "@typescript-eslint/explicit-member-accessibility": "error",
            "@typescript-eslint/ban-ts-comment": [
                "error",
                {
                    "ts-ignore": "allow-with-description",
                    "ts-nocheck": true,
                    "ts-check": false,
                    "ts-expect-error": "allow-with-description",
                },
            ],
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            "lines-between-class-members": ["error", "never"],
            "no-restricted-syntax": ["error", ...FOOTPRINT_GEOMETRY_RESTRICTIONS],
        },
    },

    // Test files: parsed + linted by the TypeScript block above. Add Jest globals and relax a few
    // rules that are noisy (and not meaningful) in tests — mocks legitimately use `any`, test helper
    // classes don't need member spacing, and assertion calls can read as unused expressions.
    {
        files: ["test/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
        languageOptions: {
            globals: {
                ...globals.jest,
            },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-expressions": "off",
            "lines-between-class-members": "off",
        },
    },
];
