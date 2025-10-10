/**
 * DOM utility functions
 * @module browser/shared/utils/dom
 */

/**
 * Escape HTML special characters to prevent XSS attacks
 * Reference: https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html
 */
export function escapeHtml(text: string | null | undefined): string {
  if (text == null) return '';
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };
  return String(text).replace(/[&<>"'/]/g, m => map[m]);
}

/**
 * Convert camelCase or snake_case to Title Case
 */
export function toTitleCase(text: string): string {
  const label = text.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Create an HTML element with attributes and children
 */
export function createElement(
  tag: string,
  attributes: Record<string, string> = {},
  children: (string | HTMLElement)[] = []
): HTMLElement {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') {
      element.className = value;
    } else {
      element.setAttribute(key, value);
    }
  }

  for (const child of children) {
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else {
      element.appendChild(child);
    }
  }

  return element;
}

/**
 * Set innerHTML safely (assumes content has been properly escaped)
 */
export function setInnerHTML(element: HTMLElement, html: string): void {
  element.innerHTML = html;
}

/**
 * Get element by ID with type safety
 */
export function getElementByIdSafe<T extends HTMLElement = HTMLElement>(
  id: string
): T | null {
  return document.getElementById(id) as T | null;
}

/**
 * Query selector with type safety
 */
export function querySelectorSafe<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: Document | HTMLElement = document
): T | null {
  return parent.querySelector(selector) as T | null;
}

/**
 * Query selector all with type safety
 */
export function querySelectorAllSafe<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: Document | HTMLElement = document
): NodeListOf<T> {
  return parent.querySelectorAll(selector) as NodeListOf<T>;
}
