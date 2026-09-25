// Offline support for every page: installs the service worker (sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is a bonus; the site works without it */
    });
  });
}
