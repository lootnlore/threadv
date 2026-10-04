// The scripts the site ships, for the build and its tests. Browser modules
// in dependency order (a module's imports come before it), each published
// as <name>.<content hash>.js with its imports rewritten; then the classic
// scripts (offline support on every page, and analytics). The pages load
// "app", "offline" and "analytics" by those names. A name is
// lowercase letters only, and a module's is its file's: the build's import
// rewrite, the service worker carrying assets across updates, nginx's
// long-cache rule (deploy/nginx/threadvet.conf) and deploy.sh carrying the
// last release's assets forward all read names so. The build refuses
// any other, a name used twice, and "css" (the stylesheet's).
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
