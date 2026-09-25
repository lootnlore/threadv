#!/usr/bin/env node
// Tiny static server for previewing dist/ locally: `npm run serve`, then
// open http://localhost:8080. Mirrors the nginx rules (pretty URLs with a
// trailing-slash redirect, the 404 page with a 404 status, hidden files
// refused). The e2e tests reuse createStaticHandler so they exercise the same
// behaviour.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** The file for `pathname` under `root`, or null if it would fall outside root (even in a sibling such as dist-old/). */
export function insideRoot(root, pathname) {
  const file = join(root, normalize(pathname));
  return file === root || file.startsWith(root + sep) ? file : null;
}

/** Request handler serving `root` (a directory path) like the production nginx config. */
export function createStaticHandler(dir) {
  const root = resolvePath(dir);
  async function resolve(pathname) {
    const file = insideRoot(root, pathname);
    if (!file) return null;
    try {
      const info = await stat(file);
      const target = info.isDirectory() ? join(file, 'index.html') : file;
      await stat(target);
      return target;
    } catch {
      return null;
    }
  }

  const notFound = async (res) => {
    const body = await readFile(join(root, '404.html'));
    res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' }).end(body);
  };

  return async function handle(req, res) {
    let pathname;
    let encoded;
    let search;
    try {
      // Prefix the origin rather than passing it as a base: as a base,
      // "//fees" would be read as a host name, not a path.
      if (!req.url.startsWith('/')) throw new Error('not a path');
      const url = new URL(`http://localhost${req.url}`);
      // Merge repeated slashes like nginx does: otherwise //example.com would
      // redirect to //example.com/, which browsers treat as another site.
      encoded = url.pathname.replace(/\/{2,}/g, '/');
      pathname = decodeURIComponent(encoded).replace(/\/{2,}/g, '/');
      search = url.search;
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    try {
      // nginx refuses dotfiles (the build marker, .git...) apart from .well-known,
      // and only serves the 404 page as an error page.
      if (/\/\.(?!well-known\/)/.test(pathname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
        return;
      }
      if (pathname === '/404.html') return await notFound(res);
      if (!pathname.endsWith('/') && !extname(pathname) && (await resolve(`${pathname}/`))) {
        // Built from the still-encoded path, so the header stays valid ASCII.
        res.writeHead(301, { Location: `${encoded}/${search}` }).end();
        return;
      }
      const file = await resolve(pathname);
      if (!file) return await notFound(res);
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (err) {
      console.error(err);
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error. Did the build finish? Run npm run build.');
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  const port = Number(process.env.PORT) || 8080;
  createServer(createStaticHandler(root)).listen(port, () => console.log(`Previewing dist/ at http://localhost:${port}`));
}
