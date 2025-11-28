/**
 * Base class for browser components with proper lifecycle management
 * Ensures all event listeners and intervals are cleaned up on destroy
 * @module browser/shared/components/DisposableComponent
 */

type EventListenerEntry = {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
};

export abstract class DisposableComponent {
  private _eventListeners: EventListenerEntry[] = [];
  private _intervals: ReturnType<typeof setInterval>[] = [];
  private _isDestroyed = false;

  /**
   * Register an event listener for automatic cleanup
   * Use this instead of element.addEventListener directly
   */
  protected addManagedEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (this._isDestroyed) return;
    target.addEventListener(type, listener, options);
    this._eventListeners.push({ target, type, listener, options });
  }

  /**
   * Register an interval for automatic cleanup
   * Use this instead of setInterval directly
   */
  protected addManagedInterval(
    callback: () => void,
    ms: number
  ): ReturnType<typeof setInterval> {
    const id = setInterval(callback, ms);
    this._intervals.push(id);
    return id;
  }

  /**
   * Check if the component has been destroyed
   */
  protected get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Clean up all managed resources
   * Override in subclasses but ALWAYS call super.destroy()
   */
  destroy(): void {
    if (this._isDestroyed) return;
    this._isDestroyed = true;

    // Remove all event listeners
    for (const { target, type, listener, options } of this._eventListeners) {
      target.removeEventListener(type, listener, options);
    }
    this._eventListeners = [];

    // Clear all intervals
    for (const id of this._intervals) {
      clearInterval(id);
    }
    this._intervals = [];
  }
}
