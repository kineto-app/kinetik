/** Follow the visible viewport, including keyboards that only resize it (Safari). */
export function setupViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // Do not fit the app to pinch zoom; preserve native magnification and panning.
      if (viewport.scale !== 1) return;
      document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
      document.documentElement.style.setProperty('--app-top', `${viewport.offsetTop}px`);
    });
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
}
