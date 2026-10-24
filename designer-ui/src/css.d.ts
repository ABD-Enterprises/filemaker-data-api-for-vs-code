// Ambient declaration so TypeScript accepts side-effect CSS imports
// (`import './styles.css'`). esbuild handles the actual bundling at build
// time; this is type-only and emits nothing.
declare module '*.css';
