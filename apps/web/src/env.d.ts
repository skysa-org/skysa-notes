interface ImportMetaEnv {
	/** `package.json`'s version, set by `vite.config.ts`. Absent under Vitest. */
	readonly VITE_APP_VERSION?: string;
	/** The brand's `name` (`brand.ts`), set by `vite.config.ts`. Absent under Vitest. */
	readonly VITE_APP_NAME?: string;
}
