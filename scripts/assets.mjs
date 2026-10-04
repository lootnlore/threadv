// The scripts the site ships, for the build and its tests. Browser modules
// in dependency order (a module's imports come before it), each published
// as <name>.<content hash>.js with its imports rewritten; then the classic
// scripts (offline support on every page, and analytics). A name is
// lowercase letters only: the build's import rewrite and the service
// worker's carrying of assets across updates both read names so (the build
// refuses any other).
export const MODULES = [
  ['src/engine/fees.mjs', 'fees'],
  ['src/engine/calc.mjs', 'calc'],
  ['src/engine/render.mjs', 'render'],
  ['src/assets/app.js', 'app'],
];
export const CLASSIC_SCRIPTS = [
  ['src/assets/offline.js', 'offline'],
  ['src/assets/analytics.js', 'analytics'],
];
