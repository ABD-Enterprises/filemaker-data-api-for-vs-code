// Replaced by esbuild `define` at bundle time (scripts/esbuild-config.mjs). Not defined when the
// code runs from source (tests, `tsc`), where src/about/aboutInfo.ts falls back to 'unknown'.
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_DATE__: string | undefined;
