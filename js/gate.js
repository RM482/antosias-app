import { el } from './dom.js?v=28';

const sessionEl = document.getElementById('session');

// Hold-to-exit parent gate, shared by session mode (session.js) and the
// child-first flow (child.js). Appends the gate to the #session overlay;
// a completed 3-second hold calls onExit.
export function mountParentGate(onExit) {
  const gate = el('button', { type: 'button', class: 'parent-gate', 'aria-label': 'Hold to exit to parent area' });
  const dot = el('div', { class: 'parent-gate-dot' });
  const fill = el('div', { class: 'parent-gate-fill' });
  dot.appendChild(fill);
  gate.appendChild(dot);

  // Plain touch events (not Pointer Events, which have had capture/leave
  // quirks on iOS Safari). We deliberately don't listen for touchmove, so
  // finger drift during the hold has no effect — only an actual lift
  // (touchend) or an OS-level gesture takeover (touchcancel) cancels it.
  let timer = null;
  const start = (e) => {
    if (e.cancelable) e.preventDefault();
    fill.classList.add('filling');
    timer = setTimeout(() => {
      fill.classList.remove('filling');
      onExit();
    }, 3000);
  };
  const cancel = () => {
    clearTimeout(timer);
    fill.classList.remove('filling');
  };

  gate.addEventListener('touchstart', start, { passive: false });
  gate.addEventListener('touchend', cancel);
  gate.addEventListener('touchcancel', cancel);
  // Mouse fallback so this is still testable in a desktop browser.
  gate.addEventListener('mousedown', start);
  gate.addEventListener('mouseup', cancel);
  gate.addEventListener('mouseleave', cancel);

  sessionEl.appendChild(gate);
}
