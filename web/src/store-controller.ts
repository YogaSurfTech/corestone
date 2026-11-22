import type { ReactiveController, ReactiveControllerHost } from "lit";
import { store, type State } from "./store";

/**
 * Keeps an element in line with the store: while the element is in the page,
 * `state` is the store's state and every change of it updates the element.
 * With `changed`, the element also hears of every state (first: the first one
 * it ever got), to load what the new state asks for.
 */
export class StoreController implements ReactiveController {
  state: State = store.state;
  private unsub?: () => void;
  private seen = false;

  constructor(private readonly host: ReactiveControllerHost, private readonly changed?: (state: State, first: boolean) => void) {
    host.addController(this);
  }

  hostConnected(): void {
    this.unsub = store.subscribe((s) => {
      this.state = s;
      const first = !this.seen;
      this.seen = true;
      this.changed?.(s, first);
      this.host.requestUpdate();
    });
  }

  hostDisconnected(): void {
    this.unsub?.();
    this.unsub = undefined;
  }
}
