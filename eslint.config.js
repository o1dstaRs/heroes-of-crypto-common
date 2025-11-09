import typescriptPlugin from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
    {
        files: ["src/**/*.ts"],
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
        },
    },

    // Test files (Jest globals only here)
    {
        files: ["test/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
        languageOptions: {
            globals: {
                ...globals.jest,
            },
        },
    },
];
