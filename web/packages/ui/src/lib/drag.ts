export interface DragOptions {
  /** Called for every pointer move while the button is held. */
  move(m: PointerEvent): void;
  /** Called once when the pointer is released or the drag is cancelled. */
  end?(): void;
  /** A class the element carries during the drag. */
  cls?: string;
}

/**
 * Follows the pointer from a pointerdown on an element until it is released.
 * The element captures the pointer, so the drag goes on outside of it.
 */
export function drag(e: PointerEvent, o: DragOptions): void {
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  if (o.cls) target.classList.add(o.cls);
  const stop = () => {
    if (o.cls) target.classList.remove(o.cls);
    target.removeEventListener("pointermove", o.move);
    target.removeEventListener("pointerup", stop);
    target.removeEventListener("pointercancel", stop);
    o.end?.();
  };
  target.addEventListener("pointermove", o.move);
  target.addEventListener("pointerup", stop);
  target.addEventListener("pointercancel", stop);
}
