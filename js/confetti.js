// Confetti burst for celebrations (correct tap, end-of-session sticker).
// Purely visual — no audio (one-sound-at-a-time stays media.js's business),
// no reads/writes, pointer-events:none so it can never swallow a toddler tap.
// The layer is appended to a container that survives stage re-renders (e.g.
// #session itself, not the .session-screen that gets removed) and cleans
// itself up when the animation is over.

const COLORS = ['#e5533d', '#f2b134', '#4a90d9', '#7bb661', '#b085c9', '#f28cb1'];

// x/y are pixel coordinates inside `container` (defaults to its top-middle).
export function confettiBurst(container, { x, y, count = 26 } = {}) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = container.getBoundingClientRect();
  const originX = x ?? rect.width / 2;
  const originY = y ?? rect.height * 0.3;

  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    const angle = Math.random() * Math.PI * 2;
    const distance = 60 + Math.random() * 130;
    piece.style.left = `${originX}px`;
    piece.style.top = `${originY}px`;
    piece.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    // Bias downward so it reads as falling confetti, not an explosion.
    piece.style.setProperty('--dy', `${Math.abs(Math.sin(angle)) * distance + 40}px`);
    piece.style.setProperty('--rot', `${(Math.random() * 2 - 1) * 540}deg`);
    piece.style.background = COLORS[i % COLORS.length];
    piece.style.animationDuration = `${700 + Math.random() * 500}ms`;
    layer.appendChild(piece);
  }
  container.appendChild(layer);
  setTimeout(() => layer.remove(), 1400);
}

// Burst centered on a tapped element, in the coordinate space of `container`.
export function confettiBurstAt(container, element, opts = {}) {
  const c = container.getBoundingClientRect();
  const e = element.getBoundingClientRect();
  confettiBurst(container, {
    ...opts,
    x: e.left - c.left + e.width / 2,
    y: e.top - c.top + e.height / 2,
  });
}
