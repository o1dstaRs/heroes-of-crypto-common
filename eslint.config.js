import typescriptPlugin from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";

export default [
    {
        files: ["src/**/*.ts"],
        ignores: ["scripts/**/*.js", "src/generated/**/*.{ts,js}"],
        plugins: {
            "@typescript-eslint": typescriptPlugin,
        },
        languageOptions: {
            ecmaVersion: 2018,
            sourceType: "module",
            parser: typescriptParser,
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

            // ✅ use the CORE rule (not the plugin) to remove blank lines
            "lines-between-class-members": ["error", "never"],
            // (if you had the plugin version before, remove it entirely)
        },
    },
];
