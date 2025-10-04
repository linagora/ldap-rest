import { expect } from 'chai';

import { Store, type Action } from '../../src/browser/ldap-tree-viewer/store/Store';

describe('Browser Store', () => {
  interface TestState {
    count: number;
    name: string;
  }

  const initialState: TestState = {
    count: 0,
    name: 'test',
  };

  const reducer = (state: TestState, action: Action): TestState => {
    switch (action.type) {
      case 'INCREMENT':
        return { ...state, count: state.count + 1 };
      case 'DECREMENT':
        return { ...state, count: state.count - 1 };
      case 'SET_NAME':
        return { ...state, name: action.payload as string };
      case 'RESET':
        return initialState;
      default:
        return state;
    }
  };

  describe('Store initialization', () => {
    it('should initialize with initial state', () => {
      const store = new Store(reducer, initialState);
      expect(store.getState()).to.deep.equal(initialState);
    });
  });

  describe('Store dispatch', () => {
    it('should update state on dispatch', () => {
      const store = new Store(reducer, initialState);
      store.dispatch({ type: 'INCREMENT' });
      expect(store.getState().count).to.equal(1);
    });

    it('should handle multiple dispatches', () => {
      const store = new Store(reducer, initialState);
      store.dispatch({ type: 'INCREMENT' });
      store.dispatch({ type: 'INCREMENT' });
      store.dispatch({ type: 'DECREMENT' });
      expect(store.getState().count).to.equal(1);
    });

    it('should handle actions with payload', () => {
      const store = new Store(reducer, initialState);
      store.dispatch({ type: 'SET_NAME', payload: 'new name' });
      expect(store.getState().name).to.equal('new name');
    });

    it('should return same state for unknown action', () => {
      const store = new Store(reducer, initialState);
      const stateBefore = store.getState();
      store.dispatch({ type: 'UNKNOWN_ACTION' });
      expect(store.getState()).to.deep.equal(stateBefore);
    });
  });

  describe('Store subscribe', () => {
    it('should notify subscribers on state change', () => {
      const store = new Store(reducer, initialState);
      let notified = false;

      store.subscribe(() => {
        notified = true;
      });

      store.dispatch({ type: 'INCREMENT' });
      expect(notified).to.be.true;
    });

    it('should not notify if state does not change', () => {
      const store = new Store(reducer, initialState);
      let notifyCount = 0;

      store.subscribe(() => {
        notifyCount++;
      });

      // Unknown action should not change state
      store.dispatch({ type: 'UNKNOWN_ACTION' });
      expect(notifyCount).to.equal(0);
    });

    it('should notify multiple subscribers', () => {
      const store = new Store(reducer, initialState);
      let notify1 = false;
      let notify2 = false;

      store.subscribe(() => {
        notify1 = true;
      });
      store.subscribe(() => {
        notify2 = true;
      });

      store.dispatch({ type: 'INCREMENT' });
      expect(notify1).to.be.true;
      expect(notify2).to.be.true;
    });

    it('should allow unsubscribing', () => {
      const store = new Store(reducer, initialState);
      let notifyCount = 0;

      const unsubscribe = store.subscribe(() => {
        notifyCount++;
      });

      store.dispatch({ type: 'INCREMENT' });
      expect(notifyCount).to.equal(1);

      unsubscribe();
      store.dispatch({ type: 'INCREMENT' });
      expect(notifyCount).to.equal(1); // Should not increment
    });

    it('should handle multiple subscribers with unsubscribe', () => {
      const store = new Store(reducer, initialState);
      let notify1 = 0;
      let notify2 = 0;

      const unsub1 = store.subscribe(() => {
        notify1++;
      });
      store.subscribe(() => {
        notify2++;
      });

      store.dispatch({ type: 'INCREMENT' });
      expect(notify1).to.equal(1);
      expect(notify2).to.equal(1);

      unsub1();
      store.dispatch({ type: 'INCREMENT' });
      expect(notify1).to.equal(1); // Should not increment
      expect(notify2).to.equal(2); // Should increment
    });
  });

  describe('Store immutability', () => {
    it('should not mutate previous state', () => {
      const store = new Store(reducer, initialState);
      const stateBefore = { ...store.getState() };

      store.dispatch({ type: 'INCREMENT' });

      // Previous state should remain unchanged
      expect(stateBefore.count).to.equal(0);
      expect(store.getState().count).to.equal(1);
    });
  });
});
