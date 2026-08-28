/**
 * CSS imports are a bundler feature, not a TypeScript one. Only `src/main.tsx` imports a
 * stylesheet (see the comment there), but tsc still has to be told what the specifier
 * resolves to.
 */
declare module '*.css';
