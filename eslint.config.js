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
            // Fixme: These are nice for finding errors, but ugly to handle userData with.
            // "@typescript-eslint/no-unsafe-call": "error",
            // "@typescript-eslint/no-unsafe-return": "error",
            // "@typescript-eslint/no-unsafe-member-access": "error",
            // "@typescript-eslint/no-unsafe-assignment": "error",
            "@typescript-eslint/ban-ts-comment": [
                "error",
                {
                    "ts-ignore": "allow-with-description",
                    "ts-nocheck": true,
                    "ts-check": false,
                    "ts-expect-error": "allow-with-description",
                },
            ],
        },
    },
];
