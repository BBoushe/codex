import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks"; // 1. Import the plugin
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
	// 1. Monorepo Global Ignores
	globalIgnores([
		"**/dist/",
		"**/.elysia/",
		"**/.DS_Store",
		"apps/frontend/dist/**",
		"packages/parser/fixtures/**",
	]),

	// 2. Base Configuration (Node & Bun for Backend/CLI/Packages)
	{
		files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		extends: [js.configs.recommended, tseslint.configs.recommended as any],
		languageOptions: {
			globals: {
				...globals.node,
				Bun: "readonly",
			},
			ecmaVersion: "latest",
			sourceType: "module",
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},

	// 3. Frontend & React Isolation
	{
		files: ["apps/frontend/**/*.{ts,tsx,js,jsx}"],
		extends: [
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			pluginReact.configs.flat.recommended as any,
			// If you are using v5.1.0+ of eslint-plugin-react-hooks, you can also extend it directly here:
			// pluginReactHooks.configs.flat.recommended as any,
		],
		plugins: {
			// 2. Define the plugin namespace
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			"react-hooks": pluginReactHooks as any,
		},
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
		settings: {
			react: { version: "detect" },
		},
		rules: {
			"react/react-in-jsx-scope": "off",
			// 3. Apply the hook rules directly to the frontend
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
		},
	},
]);
