/**
 * Main export file for shared browser utilities and components
 * @module browser/shared
 */

// Utility exports
export * from './utils/dom';
export * from './utils/form';
export * from './utils/schema';

// Component exports
export { Modal, type ModalOptions } from './components/Modal';
export {
  StatusMessage,
  showStatus,
  type StatusMessageOptions,
} from './components/StatusMessage';

// Type exports
export * from './types';
