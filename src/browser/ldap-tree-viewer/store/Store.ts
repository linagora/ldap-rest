/**
 * Mini Store implementation (Redux-like pattern without dependencies)
 */

export type Listener = () => void;
export type Reducer<S> = (state: S, action: Action) => S;

export interface Action {
  type: string;
  payload?: any;
}

export class Store<S> {
  private state: S;
  private reducer: Reducer<S>;
  private listeners: Set<Listener> = new Set();

  constructor(reducer: Reducer<S>, initialState: S) {
    this.reducer = reducer;
    this.state = initialState;
  }

  getState(): S {
    return this.state;
  }

  dispatch(action: Action): void {
    const prevState = this.state;
    this.state = this.reducer(this.state, action);

    // Only notify if state actually changed
    if (prevState !== this.state) {
      this.listeners.forEach(listener => listener());
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Return unsubscribe function
    return () => this.listeners.delete(listener);
  }
}
