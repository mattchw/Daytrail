import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('./editScrollAnchor.ts', import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022},
}).outputText;
const {createEditScrollAnchor} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function fixture({nested = false, modal = false, focused = true} = {}) {
  const handlers = new Map(), observers = [];
  const document = {
    activeElement: null, scrollingElement: null,
    addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(handler); },
    removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
  };
  document.defaultView = {
    getComputedStyle: element => ({overflowY: element.overflow}),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.nodes = new Set(); observers.push(this); }
      observe(node) { this.nodes.add(node); }
      disconnect() { this.nodes.clear(); }
    },
  };
  class Element {
    constructor(parent, options = {}) {
      const styles = new Map();
      Object.assign(this, {parentElement: parent, ownerDocument: document, nodeType: 1, isConnected: true,
        overflow: 'visible', clientHeight: 500, scrollHeight: 1000, offset: 0, visible: true,
        position: 'static', openDialog: false, calls: [], _scrollTop: 0, scrollLeft: 0,
        style: {
          getPropertyValue(name) { return styles.get(name)?.value ?? ''; },
          getPropertyPriority(name) { return styles.get(name)?.priority ?? ''; },
          setProperty: (name, value, priority = '') => { styles.set(name, {value, priority}); this.onStyleChange?.(); },
          removeProperty: name => { const value = styles.get(name)?.value; styles.delete(name); this.onStyleChange?.(); return value; },
        }}, options);
    }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { this._scrollTop = Math.min(this.scrollHeight - this.clientHeight, Math.max(0, value)); }
    scrollTo(options) { this.calls.push(options); this.scrollTop = options.top; if (options.left !== undefined) this.scrollLeft = options.left; }
    contains(target) { for (let node = target; node; node = node.parentElement) if (node === this) return true; return false; }
    closest() { for (let node = this; node; node = node.parentElement) if (node.openDialog) return node; return null; }
    getClientRects() { return this.visible ? [{}] : []; }
    getBoundingClientRect() {
      let top = this.offset;
      for (let node = this.parentElement; node; node = node.parentElement) {
        top += node.offset - node.scrollTop;
        if (node.position === 'fixed') break;
      }
      return {top};
    }
  }
  const root = new Element(null, {scrollHeight: 3000, clientHeight: 800});
  document.scrollingElement = root;
  const outer = new Element(root, {overflow: nested ? 'auto' : 'visible', scrollHeight: 1200, clientHeight: 500});
  const panel = new Element(outer, {overflow: 'auto', scrollHeight: 1600, clientHeight: 500,
    openDialog: modal, position: modal ? 'fixed' : 'static'});
  const card = new Element(panel), control = new Element(card, {offset: 350});
  const icon = new Element(control), outside = new Element(panel);
  document.activeElement = focused ? control : root;
  const emit = (type, values = {}) => { for (const handler of [...handlers.get(type) ?? []]) handler({target: control, ...values}); };
  const resize = () => { for (const observer of observers) if (observer.nodes.size) observer.callback(); };
  return {document, root, outer, panel, card, control, icon, outside, emit, resize, observers, handlers,
    anchor: createEditScrollAnchor(control)};
}

let passed = 0;
function check(name, run) { run(); passed++; console.log(`✓ ${name}`); }

check('a height change above an editing control keeps its viewport position', () => {
  const f = fixture(), top = f.control.getBoundingClientRect().top;
  f.card.offset += 95; f.anchor.restore();
  assert.equal(f.control.getBoundingClientRect().top, top);
  assert.equal(f.panel.scrollTop, 95); assert.equal(f.root.scrollTop, 0);
  assert.equal(f.panel.calls[0].behavior, 'instant');
  assert.equal(f.document.activeElement, f.control);
  f.anchor.stop();
});
check('async card resizing is anchored without a parent render', () => {
  const f = fixture(), top = f.control.getBoundingClientRect().top;
  f.card.offset += 32; f.resize();
  assert.equal(f.control.getBoundingClientRect().top, top); f.anchor.stop();
});
check('nested scroll containers pass a clamped remainder to their outer parent', () => {
  const f = fixture({nested: true}), top = f.control.getBoundingClientRect().top;
  f.panel.scrollHeight = f.panel.clientHeight + 20;
  f.card.offset += 80; f.anchor.restore();
  assert.equal(f.panel.scrollTop, 20); assert.equal(f.outer.scrollTop, 60);
  assert.equal(f.control.getBoundingClientRect().top, top); f.anchor.stop();
});
check('document scrolling absorbs a shift when inner containers cannot', () => {
  const f = fixture(), top = f.control.getBoundingClientRect().top;
  f.panel.scrollHeight = f.panel.clientHeight;
  f.card.offset += 50; f.anchor.restore();
  assert.equal(f.root.scrollTop, 50); assert.equal(f.control.getBoundingClientRect().top, top); f.anchor.stop();
});
check('a fixed dialog never scrolls its inert background at its own boundary', () => {
  const f = fixture({modal: true});
  f.panel.scrollHeight = f.panel.clientHeight + 10;
  f.card.offset += 50; f.anchor.restore();
  assert.equal(f.panel.scrollTop, 10); assert.equal(f.root.scrollTop, 0); assert.equal(f.outer.scrollTop, 0); f.anchor.stop();
});
check('shrinking content restores upward within the available scroll range', () => {
  const f = fixture(); f.card.offset += 150; f.anchor.restore();
  f.card.offset -= 70; f.anchor.restore();
  assert.equal(f.panel.scrollTop, 80); f.anchor.stop();
});
for (const [name, event, values] of [
  ['wheel', 'wheel', {}], ['touch', 'touchstart', {}],
  ['PageDown', 'keydown', {key: 'PageDown'}], ['Tab', 'keydown', {key: 'Tab'}],
  ['external pointer', 'pointerdown', {outside: true}],
  ['external focus', 'focusin', {outside: true}],
  ['focus leaving', 'focusout', {relatedTarget: null}],
]) check(`${name} releases the anchor before the next layout change`, () => {
  const f = fixture(); f.emit(event, values.outside ? {target: f.outside} : values);
  f.card.offset += 80; f.anchor.restore(); f.resize();
  assert.equal(f.panel.scrollTop, 0); assert.equal(f.root.scrollTop, 0);
  assert.equal([...f.handlers.values()].reduce((total, entries) => total + entries.size, 0), 0);
});
check('clicking a control icon and keyboard activation keep the same control stable', () => {
  const f = fixture(); f.emit('pointerdown', {target: f.icon}); f.emit('keydown', {key: ' '}); f.emit('keydown', {key: 'Enter'});
  f.card.offset += 40; f.anchor.restore(); assert.equal(f.panel.scrollTop, 40); f.anchor.stop();
});
check('Safari pointer clicks can stay anchored without forcing focus onto the button', () => {
  const f = fixture({focused: false}); f.card.offset += 40; f.anchor.restore();
  assert.equal(f.panel.scrollTop, 40); assert.equal(f.document.activeElement, f.root);
  f.emit('focusin', {target: f.outside}); f.card.offset += 25; f.anchor.restore();
  assert.equal(f.panel.scrollTop, 40);
});
check('a missed focus event still releases if another control took focus', () => {
  const f = fixture(); f.document.activeElement = f.outside; f.card.offset += 40; f.anchor.restore();
  assert.equal(f.panel.scrollTop, 0);
});
check('removed or hidden controls release without scrolling or refocusing', () => {
  for (const field of ['isConnected', 'visible']) {
    const f = fixture(); f.control[field] = false; f.card.offset += 60; f.anchor.restore();
    assert.equal(f.panel.scrollTop, 0); assert.equal(f.observers[0].nodes.size, 0);
  }
});
check('stop is idempotent and disconnects layout observers and event listeners', () => {
  const f = fixture(); f.anchor.stop(); f.anchor.stop(); f.card.offset += 70; f.anchor.restore(); f.resize();
  assert.equal(f.panel.scrollTop, 0); assert.equal(f.observers[0].nodes.size, 0);
  assert.equal([...f.handlers.values()].reduce((total, entries) => total + entries.size, 0), 0);
});
check('manual anchoring disables native anchoring before any layout change and releases it on scroll', () => {
  const f = fixture({nested: true});
  for (const scroller of [f.panel, f.outer, f.root]) {
    assert.equal(scroller.style.getPropertyValue('overflow-anchor'), 'none');
    assert.equal(scroller.style.getPropertyPriority('overflow-anchor'), 'important');
  }
  f.emit('wheel');
  for (const scroller of [f.panel, f.outer, f.root]) assert.equal(scroller.style.getPropertyValue('overflow-anchor'), '');
});
check('release restores the exact previous inline anchoring value and priority', () => {
  const f = fixture(); f.anchor.stop();
  f.panel.style.setProperty('overflow-anchor', 'auto', 'important');
  f.root.style.setProperty('overflow-anchor', 'none');
  const anchor = createEditScrollAnchor(f.control); anchor.stop();
  assert.equal(f.panel.style.getPropertyValue('overflow-anchor'), 'auto');
  assert.equal(f.panel.style.getPropertyPriority('overflow-anchor'), 'important');
  assert.equal(f.root.style.getPropertyValue('overflow-anchor'), 'none');
  assert.equal(f.root.style.getPropertyPriority('overflow-anchor'), '');
});
check('a modal owns anchoring only within the sheet, leaving background styles alone', () => {
  const f = fixture({modal: true, nested: true});
  assert.equal(f.panel.style.getPropertyValue('overflow-anchor'), 'none');
  assert.equal(f.outer.style.getPropertyValue('overflow-anchor'), '');
  assert.equal(f.root.style.getPropertyValue('overflow-anchor'), ''); f.anchor.stop();
});
check('newly scrollable containers are covered without overwriting later external style changes', () => {
  const f = fixture(); f.outer.overflow = 'auto'; f.anchor.restore();
  assert.equal(f.outer.style.getPropertyValue('overflow-anchor'), 'none');
  f.outer.style.setProperty('overflow-anchor', 'auto'); f.anchor.stop();
  assert.equal(f.outer.style.getPropertyValue('overflow-anchor'), 'auto');
});
check('releasing a dialog anchor preserves scroll offsets when restoring CSS resets them', () => {
  const f = fixture({modal: true});
  f.card.offset += 90; f.anchor.restore();
  f.card.offset -= 70; f.anchor.restore();
  assert.equal(f.panel.scrollTop, 20); const top = f.control.getBoundingClientRect().top;
  f.panel.scrollLeft = 12;
  f.panel.onStyleChange = () => {f.panel.scrollTop = 0; f.panel.scrollLeft = 0;};
  f.anchor.stop();
  assert.equal(f.panel.scrollTop, 20); assert.equal(f.panel.scrollLeft, 12);
  assert.equal(f.control.getBoundingClientRect().top, top);
  assert.equal(f.root.scrollTop, 0);
  f.panel.onStyleChange = undefined;
  const next = createEditScrollAnchor(f.control);
  f.card.offset += 70; next.restore();
  assert.equal(f.control.getBoundingClientRect().top, top); next.stop();
});
check('release snapshots all nested offsets before any style restoration changes them', () => {
  const f = fixture({nested: true});
  f.panel.scrollTop = 40; f.outer.scrollTop = 50; f.root.scrollTop = 60;
  f.panel.onStyleChange = () => {f.panel.scrollTop = 0; f.outer.scrollTop = 0; f.root.scrollTop = 0;};
  f.anchor.stop();
  assert.deepEqual([f.panel.scrollTop, f.outer.scrollTop, f.root.scrollTop], [40, 50, 60]);
});
console.log(`\n${passed} edit scroll anchor checks passed.`);
