// Light or dark, set on <html> before the page draws so it never flashes the
// wrong colors. "System" (the default) follows the device and changes with it.
(function () {
  var KEY = 'scratchpad-theme';
  var media = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
  var BARS = { light: '#f5f1eb', dark: '#0b1220' };

  function chosen() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function apply() {
    var pick = chosen();
    var theme = pick === 'system' ? (media && media.matches ? 'light' : 'dark') : pick;
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BARS[theme]);
    return theme;
  }

  window.scratchTheme = {
    get: chosen,
    set: function (pick) {
      try {
        if (pick === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pick);
      } catch (e) {}
      return apply();
    }
  };

  apply();
  if (media) {
    var onChange = function () { if (chosen() === 'system') apply(); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }
  // Another tab changed it.
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
})();
