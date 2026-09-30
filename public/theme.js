// Apply the saved appearance before the app paints. Only this preference uses localStorage.
(() => {
  const key = 'kinetik-appearance';
  const system = matchMedia('(prefers-color-scheme: dark)');
  const valid = (value) => (['light', 'dark', 'system'].includes(value) ? value : 'system');
  let preference = 'system';
  try {
    preference = valid(localStorage.getItem(key));
  } catch {
    /* Session-only when storage is unavailable. */
  }
  function apply() {
    const root = document.documentElement;
    root.dataset.appearance = preference;
    root.dataset.theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    const select = document.getElementById('appearance');
    if (select) select.value = preference;
    if (document.readyState !== 'loading') {
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', getComputedStyle(root).backgroundColor);
    }
  }
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('change', (event) => {
    if (event.target instanceof HTMLSelectElement && event.target.id === 'appearance') {
      preference = valid(event.target.value);
      try {
        localStorage.setItem(key, preference);
      } catch {
        /* Keep the in-memory preference. */
      }
      apply();
    }
  });
  addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue);
      apply();
    }
  });
})();
