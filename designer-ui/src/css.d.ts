// Ambient declarations for non-code side-effect imports (e.g. `import './styles.css'`).
// The esbuild bundler resolves these at build time; this keeps `tsc` type-checking happy.
declare module '*.css';
