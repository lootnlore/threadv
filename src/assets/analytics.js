// Plausible page views (cookie-free) that never include the URL fragment or
// query string: the calculator keeps typed numbers after the #, and those
// must not leave the device. Loaded only when analytics is enabled.
window.plausible =
  window.plausible ||
  function (...args) {
    (window.plausible.q = window.plausible.q || []).push(args);
  };
window.plausible('pageview', { u: location.origin + location.pathname });
