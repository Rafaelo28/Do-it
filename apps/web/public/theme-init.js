// Erscheinungsbild sofort setzen (vor dem ersten Zeichnen), damit nichts aufblitzt.
(function () {
  var root = document.documentElement;
  var a = {};
  try {
    a = JSON.parse(localStorage.getItem('doit-appearance') || '{}') || {};
  } catch (e) {}
  var mode = a.mode || 'system';
  var dark = mode === 'dark' || (mode === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  ['style', 'density', 'radius'].forEach(function (k) {
    if (a[k]) root.setAttribute('data-' + k, a[k]);
  });
  if (a.textSize) root.setAttribute('data-text', a.textSize);
  if (a.vars) for (var k in a.vars) root.style.setProperty(k, a.vars[k]);
})();
