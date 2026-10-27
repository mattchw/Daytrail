/** Keep an actively edited control under the pointer while surrounding timing
 * details settle. This never focuses a control or prevents a user scroll.
 */
export function createEditScrollAnchor(element: HTMLElement): {restore(): void; stop(): void} {
  const document = element.ownerDocument, view = document.defaultView;
  const initialFocus = document.activeElement;
  const top = element.getBoundingClientRect().top;
  let stopped = false, restoring = false;
  let observer: ResizeObserver | undefined;
  const removers: (() => void)[] = [];
  const nativeAnchoring = new Map<HTMLElement, {value: string; priority: string}>();

  function scrollingParents() {
    const parents: HTMLElement[] = [], dialog = element.closest('dialog[open]');
    const root = document.scrollingElement as HTMLElement | null;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent === root) break;
      if (view && /(auto|scroll|overlay)/.test(view.getComputedStyle(parent).overflowY)) parents.push(parent);
      if (parent === dialog) break;
    }
    if (!dialog && root) parents.push(root);
    return parents;
  }
  function ownScrollAnchoring(parents: HTMLElement[]) {
    // Native scroll anchoring otherwise adjusts the same layout change after
    // our correction, making a mobile sheet's button jump a second time.
    for (const parent of parents) if (!nativeAnchoring.has(parent)) {
      nativeAnchoring.set(parent, {value: parent.style.getPropertyValue('overflow-anchor'),
        priority: parent.style.getPropertyPriority('overflow-anchor')});
      parent.style.setProperty('overflow-anchor', 'none', 'important');
    }
  }

  function contains(target: EventTarget | null): boolean {
    return !!target && 'nodeType' in target && element.contains(target as Node);
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    for (const remove of removers) remove();
    const offsets = [...nativeAnchoring.keys()].map(parent => ({parent, top: parent.scrollTop, left: parent.scrollLeft}));
    for (const [parent, previous] of nativeAnchoring) {
      if (parent.style.getPropertyValue('overflow-anchor') !== 'none'
        || parent.style.getPropertyPriority('overflow-anchor') !== 'important') continue;
      if (previous.value) parent.style.setProperty('overflow-anchor', previous.value, previous.priority);
      else parent.style.removeProperty('overflow-anchor');
    }
    // Re-enabling browser anchoring can synchronously apply an old anchor and
    // reset a sheet's scroll offset. Releasing this helper must not itself move
    // the page (including when the next +/- click creates a fresh anchor).
    for (const {parent, top, left} of offsets) {
      if (parent.scrollTop !== top || parent.scrollLeft !== left) parent.scrollTo({top, left, behavior: 'instant'});
    }
    nativeAnchoring.clear();
  }
  function restore() {
    if (stopped || restoring || !view) return;
    if (!element.isConnected || !element.getClientRects().length
      || document.activeElement !== initialFocus && !contains(document.activeElement)) { stop(); return; }
    restoring = true;
    try {
      // A modal's inert background must not move if the sheet itself has no
      // remaining scroll range. For the normal planner, the document is last.
      const scrollers = scrollingParents();
      ownScrollAnchoring(scrollers);
      for (const scroller of scrollers) {
        if (scroller.scrollHeight <= scroller.clientHeight) continue;
        const delta = element.getBoundingClientRect().top - top;
        if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) break;
        // Re-measure after each scroll: browser clamping or nested containers
        // can leave a remainder for an outer scrolling parent to absorb.
        scroller.scrollTo({top: scroller.scrollTop + delta, behavior: 'instant'});
      }
    } finally { restoring = false; }
  }
  function listen(type: string, handler: EventListener) {
    document.addEventListener(type, handler, {capture: true, passive: true});
    removers.push(() => document.removeEventListener(type, handler, true));
  }

  if (!view || !element.isConnected || !Number.isFinite(top)) return {restore, stop};
  ownScrollAnchoring(scrollingParents());
  listen('wheel', stop);
  listen('touchstart', stop);
  listen('pointerdown', event => { if (!contains(event.target)) stop(); });
  listen('focusin', event => { if (!contains(event.target)) stop(); });
  listen('focusout', event => {
    if (contains(event.target) && !contains((event as FocusEvent).relatedTarget)) stop();
  });
  listen('keydown', event => {
    const key = (event as KeyboardEvent).key;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Tab'].includes(key)
      || (key === ' ' || key === 'Spacebar') && !contains(event.target)) stop();
  });
  // Child-only renders (for example a lazy photo's credit) need the same
  // protection as the parent's useLayoutEffect after a duration update.
  if (typeof view.ResizeObserver === 'function') {
    observer = new view.ResizeObserver(restore);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) observer.observe(parent);
  }
  return {restore, stop};
}
