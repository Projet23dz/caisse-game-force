// Appliqué avant le rendu : thème et sens d'écriture mémorisés (évite un flash).
try {
  document.documentElement.dataset.theme = localStorage.getItem('cp.theme') || 'game-force-dark';
  var l = localStorage.getItem('cp.lang') || 'ar';
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
} catch (e) { /* stockage indisponible */ }
