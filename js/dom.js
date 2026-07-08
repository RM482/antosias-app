export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// Toddler-friendly tap: fires when the finger lifts (touchend), no matter how
// long it pressed or how much it wobbled first — a browser "click" requires a
// clean quick tap that toddler hands often don't produce. preventDefault on
// touchend also stops the browser's synthetic click (no double-fire) and
// double-tap zoom. Plain click stays as the desktop/mouse fallback.
export function onTap(node, handler) {
  node.addEventListener('touchend', (e) => {
    e.preventDefault();
    handler(e);
  });
  node.addEventListener('click', handler);
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
