/**
 * Main export file for shared browser utilities and components
 * @module browser/shared
 */

// Utility exports
export * from './utils/dom.js';
export * from './utils/form.js';
export * from './utils/schema.js';
export * from './utils/totp.js';

// Component exports
export { Modal, type ModalOptions } from './components/Modal.js';
export {
  StatusMessage,
  showStatus,
  type StatusMessageOptions,
} from './components/StatusMessage.js';

// Type exports
export * from './types/index.js';
