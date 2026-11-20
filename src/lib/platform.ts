/** Static platform facts, computed once at startup. */
function detect(): { isIOS: boolean; isTouch: boolean; isMac: boolean } {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { isIOS: false, isTouch: false, isMac: false };
  }
  const ua = navigator.userAgent;
  const maxTouch = navigator.maxTouchPoints || 0;
  // iPadOS 13+ reports itself as "Macintosh" — disambiguate by touch support.
  const isIPadOS = /Macintosh/.test(ua) && maxTouch > 1;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || isIPadOS;
  const isMac = !isIOS && /Mac/.test(navigator.platform || ua);
  const isTouch =
    maxTouch > 0 ||
    'ontouchstart' in window ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  return { isIOS, isTouch, isMac };
}

export const platform: { isIOS: boolean; isTouch: boolean; isMac: boolean } = detect();
