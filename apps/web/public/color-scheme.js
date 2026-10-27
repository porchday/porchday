// Apply the browser-local color scheme before first paint (the CSP disallows inline scripts).
// Mirrors parseColorScheme in src/color-scheme.ts, which takes over after startup.
(function () {
  var preference = 'system', root = document.documentElement;
  try { preference = localStorage.getItem('porchday.color-scheme.v1') || 'system'; } catch (error) { /* storage blocked */ }
  if (preference !== 'light' && preference !== 'dark') preference = 'system';
  var dark = preference === 'dark';
  if (preference === 'system') try { dark = matchMedia('(prefers-color-scheme: dark)').matches; } catch (error) { /* unsupported */ }
  root.dataset.colorScheme = dark ? 'dark' : 'light';
  root.dataset.colorPreference = preference;
})();
