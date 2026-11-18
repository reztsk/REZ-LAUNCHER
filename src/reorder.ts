// Drag & drop reordering of the library cards (pointer events: HTML5 drag &
// drop is taken over by the webview's file drop on Windows).

const THRESHOLD = 6;

let current: { grid: HTMLElement; ctrl: AbortController; onDone: (ids: number[]) => void } | null = null;

/** Stop reordering (sort or grouping changed). */
export function disableReorder(): void {
  current?.ctrl.abort();
  current?.grid.classList.remove("reorderable");
  current = null;
}

/** Make the `.card` children of `grid` draggable; `onDone` gets the new id order.
 *  Safe to call on every render: listeners are installed once per grid. */
export function enableReorder(grid: HTMLElement, onDone: (ids: number[]) => void): void {
  if (current?.grid === grid) {
    current.onDone = onDone;
    return;
  }
  disableReorder();
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  current = { grid, ctrl, onDone };
  const self = current;
  grid.classList.add("reorderable");
  let drag: {
    card: HTMLElement;
    ghost: HTMLElement | null;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    pointerId: number;
  } | null = null;
  let justDragged = false;

  const cards = () => [...grid.querySelectorAll<HTMLElement>(":scope > .card")];

  /** FLIP: animate cards from their old to their new position. */
  const flip = (mutate: () => void) => {
    const before = new Map(cards().map((c) => [c, c.getBoundingClientRect()]));
    mutate();
    for (const c of cards()) {
      const a = before.get(c);
      if (!a || c === drag?.card) continue;
      const b = c.getBoundingClientRect();
      const x = a.left - b.left;
      const y = a.top - b.top;
      if (!x && !y) continue;
      c.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], {
        duration: 260,
        easing: "cubic-bezier(.2,.8,.2,1)",
      });
    }
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>(".card");
    if (!card || card.parentElement !== grid || t.closest("input, textarea, select, .options, .opt-toggle")) return;
    const r = card.getBoundingClientRect();
    drag = { card, ghost: null, startX: e.clientX, startY: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, pointerId: e.pointerId };
  };

  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < THRESHOLD) return;
      const r = drag.card.getBoundingClientRect();
      const ghost = drag.card.cloneNode(true) as HTMLElement;
      ghost.classList.add("drag-ghost");
      ghost.style.width = `${r.width}px`;
      ghost.style.removeProperty("view-transition-name");
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.card.classList.add("drag-placeholder");
      document.body.classList.add("is-reordering");
    }
    drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px) rotate(-2deg) scale(1.04)`;
    // Card under the pointer (the ghost ignores pointer events).
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".card");
    if (!over || over === drag.card || over.parentElement !== grid) return;
    const r = over.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    const target = after ? over.nextElementSibling : over;
    if (target === drag.card || target === drag.card.nextElementSibling && !after) return;
    flip(() => grid.insertBefore(drag!.card, target));
  };

  const finish = () => {
    if (!drag) return;
    const moved = !!drag.ghost;
    drag.ghost?.remove();
    drag.card.classList.remove("drag-placeholder");
    document.body.classList.remove("is-reordering");
    drag = null;
    if (moved) {
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
      self.onDone(cards().map((c) => Number(c.dataset.id)));
    }
  };

  // Auto-scroll of the main view while dragging near its top / bottom edge.
  const scroller = grid.closest<HTMLElement>("#view");
  let lastY = 0;
  const tick = () => {
    if (drag?.ghost && scroller) {
      const r = scroller.getBoundingClientRect();
      if (lastY < r.top + 70) scroller.scrollTop -= 14;
      else if (lastY > r.bottom - 70) scroller.scrollTop += 14;
    }
    if (drag) requestAnimationFrame(tick);
  };

  grid.addEventListener("pointerdown", (e) => {
    onDown(e);
    if (drag) requestAnimationFrame(tick);
  }, { signal });
  window.addEventListener(
    "pointermove",
    (e) => {
      lastY = e.clientY;
      onMove(e);
    },
    { signal },
  );
  window.addEventListener("pointerup", finish, { signal });
  window.addEventListener("pointercancel", finish, { signal });
  // A drag must not count as a click (play / open box).
  grid.addEventListener(
    "click",
    (e) => {
      if (justDragged) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    { capture: true, signal },
  );
}
