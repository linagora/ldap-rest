# Browser Libraries - LDAP-Rest

This guide covers LDAP-Rest's browser libraries for building LDAP management interfaces in web applications.

## Table of Contents

- [Overview](#overview)
- [LdapTreeViewer](#ldaptreeviewer)
  - [Installation](#ldaptreeviewer-installation)
  - [Basic Usage](#ldaptreeviewer-basic-usage)
  - [Configuration Options](#ldaptreeviewer-configuration-options)
  - [Public Methods](#ldaptreeviewer-public-methods)
  - [TreeNode Structure](#treenode-structure)
  - [Advanced Examples](#ldaptreeviewer-advanced-examples)
- [LdapUserEditor](#ldapusereditor)
  - [Installation](#ldapusereditor-installation)
  - [Basic Usage](#ldapusereditor-basic-usage)
  - [Configuration Options](#ldapusereditor-configuration-options)
  - [Public Methods](#ldapusereditor-public-methods)
  - [Features](#ldapusereditor-features)
  - [CSS Customization](#ldapusereditor-css-customization)
- [LdapUnitEditor](#ldapuniteditor)
  - [Installation](#ldapuniteditor-installation)
  - [Basic Usage](#ldapuniteditor-basic-usage)
  - [Features](#ldapuniteditor-features)

---

## Overview

LDAP-Rest provides three ready-to-use browser libraries for building LDAP management interfaces:

- **LdapTreeViewer** - Interactive hierarchical tree view of LDAP organizations
- **LdapUserEditor** - Complete user management interface with organization tree, user list, and edit form
- **LdapUnitEditor** - Organization management interface with create, move, edit, and delete operations

All libraries are:

- **Framework-agnostic** - Work with vanilla JavaScript or any framework
- **TypeScript-first** - Full type definitions included
- **Material Design** - Clean, modern UI following Material Design principles
- **Customizable** - CSS variables and configuration options

### Usage Modes

LDAP-Rest browser libraries can be used in two ways:

#### 1. ES Module Imports (Recommended for bundlers)

When using a bundler (Webpack, Vite, Rollup, etc.) or in modern Node.js applications, import the libraries using the package exports:

```typescript
// LDAP Tree Viewer - Main component
import LdapTreeViewer from 'ldap-rest/browser-ldap-tree-viewer-index';

// LDAP User Editor - Main component
import LdapUserEditor from 'ldap-rest/browser-ldap-user-editor-index';

// Individual components (if needed)
import LdapApiClient from 'ldap-rest/browser-ldap-tree-viewer-api-ldapapiclient';
import TreeNode from 'ldap-rest/browser-ldap-tree-viewer-components-treenode';
import UserApiClient from 'ldap-rest/browser-ldap-user-editor-api-userapiclient';
```

**Available exports:**

- **LdapTreeViewer:**
  - `browser-ldap-tree-viewer-index` - Main entry point
  - `browser-ldap-tree-viewer-ldaptreeviewer` - LdapTreeViewer class
  - `browser-ldap-tree-viewer-api-ldapapiclient` - API client
  - `browser-ldap-tree-viewer-components-treenode` - TreeNode component
  - `browser-ldap-tree-viewer-components-treeroot` - TreeRoot component
  - `browser-ldap-tree-viewer-store-store` - State store
  - `browser-ldap-tree-viewer-store-actions` - Store actions
  - `browser-ldap-tree-viewer-store-reducers` - Store reducers
  - `browser-ldap-tree-viewer-types` - TypeScript types

- **LdapUserEditor:**
  - `browser-ldap-user-editor-index` - Main entry point
  - `browser-ldap-user-editor-ldapusereditor` - LdapUserEditor class
  - `browser-ldap-user-editor-api-userapiclient` - API client
  - `browser-ldap-user-editor-components-usereditor` - UserEditor component
  - `browser-ldap-user-editor-components-userlist` - UserList component
  - `browser-ldap-user-editor-components-usertree` - UserTree component
  - `browser-ldap-user-editor-components-pointerfield` - PointerField component
  - `browser-ldap-user-editor-types` - TypeScript types

#### 2. UMD/Direct Browser Usage

For direct browser usage without a bundler, include the files via `<script>` tags (see installation sections below).

---

## LdapTreeViewer

An interactive tree component for displaying and navigating LDAP organizational structures.

<a name="ldaptreeviewer-installation"></a>

### Installation

#### With a Bundler (Webpack, Vite, Rollup, etc.)

```bash
npm install ldap-rest
```

```typescript
import LdapTreeViewer from 'ldap-rest/browser-ldap-tree-viewer-index';
// Don't forget to include Material Icons in your HTML
```

#### Direct Browser Usage

Include the required files in your HTML:

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- Material Icons (required for icons) -->
    <link
      href="https://fonts.googleapis.com/icon?family=Material+Icons"
      rel="stylesheet"
    />

    <!-- LdapTreeViewer CSS -->
    <link
      rel="stylesheet"
      href="/static/browser/ldap-tree-viewer/LdapTreeViewer.css"
    />
  </head>
  <body>
    <div id="tree-container"></div>

    <!-- LdapTreeViewer JavaScript -->
    <script src="/static/browser/ldap-tree-viewer/LdapTreeViewer.js"></script>
  </body>
</html>
```

<a name="ldaptreeviewer-basic-usage"></a>

### Basic Usage

#### With ES Modules

```typescript
import LdapTreeViewer from 'ldap-rest/browser-ldap-tree-viewer-index';

// Create and initialize the tree viewer
const viewer = new LdapTreeViewer({
  containerId: 'tree-container',
  apiBaseUrl: 'http://localhost:8081',
  onNodeClick: node => {
    console.log('Node clicked:', node.dn);
  },
  onNodeExpand: node => {
    console.log('Node expanded:', node.dn);
  },
});

// Initialize the viewer
await viewer.init();
```

#### With UMD (Direct Browser)

```javascript
// Access the library from window
const { LdapTreeViewer } = window.LdapTreeViewer;

// Create and initialize the tree viewer
const viewer = new LdapTreeViewer({
  containerId: 'tree-container',
  apiBaseUrl: 'http://localhost:8081',
  onNodeClick: node => {
    console.log('Node clicked:', node.dn);
  },
  onNodeExpand: node => {
    console.log('Node expanded:', node.dn);
  },
});

// Initialize the viewer
await viewer.init();
```

<a name="ldaptreeviewer-configuration-options"></a>

### Configuration Options

The `ViewerOptions` interface defines all available configuration options:

```typescript
interface ViewerOptions {
  // Required: ID of the HTML container element
  containerId: string;

  // Required: Base URL of the LDAP-Rest API
  apiBaseUrl: string;

  // Optional: Authentication token for API requests
  authToken?: string;

  // Optional: Root DN to start from (defaults to top organization)
  rootDn?: string;

  // Optional: Theme ('light' | 'dark')
  theme?: 'light' | 'dark';

  // Optional: Callback when a node is clicked
  onNodeClick?: (node: TreeNode) => void;

  // Optional: Callback when a node is expanded
  onNodeExpand?: (node: TreeNode) => void;
}
```

**Example with all options:**

```javascript
const viewer = new LdapTreeViewer({
  containerId: 'tree-container',
  apiBaseUrl: 'http://localhost:8081',
  authToken: 'Bearer your-token-here',
  rootDn: 'ou=divisions,dc=example,dc=com',
  theme: 'dark',
  onNodeClick: node => {
    document.getElementById('selected-dn').textContent = node.dn;
  },
  onNodeExpand: async node => {
    console.log(
      `Expanded ${node.displayName} with ${node.childrenDns.length} children`
    );
  },
});
```

<a name="ldaptreeviewer-public-methods"></a>

### Public Methods

#### `async init(): Promise<void>`

Initializes the tree viewer and loads the root organization.

```javascript
const viewer = new LdapTreeViewer({
  containerId: 'tree',
  apiBaseUrl: 'http://localhost:8081',
});
await viewer.init();
```

#### `async refresh(): Promise<void>`

Reloads the entire tree from the API.

```javascript
await viewer.refresh();
```

#### `async expandNode(dn: string): Promise<void>`

Programmatically expands a node by its DN.

```javascript
await viewer.expandNode('ou=sales,dc=example,dc=com');
```

#### `async collapseNode(dn: string): Promise<void>`

Programmatically collapses a node by its DN.

```javascript
await viewer.collapseNode('ou=sales,dc=example,dc=com');
```

#### `selectNode(dn: string | null): void`

Programmatically selects a node (or deselects if `null`).

```javascript
viewer.selectNode('ou=engineering,dc=example,dc=com');
```

#### `getState(): TreeState`

Returns the current state of the tree.

```javascript
const state = viewer.getState();
console.log('Selected node:', state.selectedNode);
console.log('Expanded nodes:', Array.from(state.expandedNodes));
console.log('Total nodes:', state.nodes.size);
```

#### `destroy(): void`

Cleans up the viewer and removes it from the DOM.

```javascript
viewer.destroy();
```

<a name="treenode-structure"></a>

### TreeNode Structure

Each node in the tree follows this TypeScript interface:

```typescript
interface TreeNode {
  // Distinguished Name (unique identifier)
  dn: string;

  // Display name shown in the tree
  displayName: string;

  // Node type: 'organization' | 'user' | 'group' | 'more'
  type: 'organization' | 'user' | 'group' | 'more';

  // Parent DN (null for root)
  parentDn: string | null;

  // Array of child DNs
  childrenDns: string[];

  // Whether children have been loaded from API
  hasLoadedChildren: boolean;

  // Whether this node can have children
  hasChildren: boolean;

  // Raw LDAP attributes from the API
  attributes?: Record<string, unknown>;
}
```

**Example TreeNode:**

```javascript
{
  dn: "ou=engineering,dc=example,dc=com",
  displayName: "Engineering",
  type: "organization",
  parentDn: "dc=example,dc=com",
  childrenDns: [
    "ou=backend,ou=engineering,dc=example,dc=com",
    "ou=frontend,ou=engineering,dc=example,dc=com"
  ],
  hasLoadedChildren: true,
  hasChildren: true,
  attributes: {
    ou: "engineering",
    objectClass: ["top", "organizationalUnit"],
    description: "Engineering department"
  }
}
```

<a name="ldaptreeviewer-advanced-examples"></a>

### Advanced Examples

#### Expand All Nodes Recursively

```javascript
async function expandAll(viewer) {
  const state = viewer.getState();
  const nodesToExpand = [];

  // Find all unexpanded nodes with children
  state.nodes.forEach((node, dn) => {
    if (node.hasChildren && !state.expandedNodes.has(dn)) {
      nodesToExpand.push(dn);
    }
  });

  // Expand each node
  for (const dn of nodesToExpand) {
    await viewer.expandNode(dn);

    // Recursively expand any new children
    await expandAll(viewer);
  }
}

// Usage
const viewer = new LdapTreeViewer({
  containerId: 'tree-container',
  apiBaseUrl: 'http://localhost:8081',
});

await viewer.init();
await expandAll(viewer);
```

#### Search and Highlight Nodes

```javascript
function highlightNodes(viewer, searchTerm) {
  const state = viewer.getState();
  const matches = [];

  state.nodes.forEach((node, dn) => {
    if (node.displayName.toLowerCase().includes(searchTerm.toLowerCase())) {
      matches.push(node);
    }
  });

  return matches;
}

// Usage
const viewer = new LdapTreeViewer({
  containerId: 'tree-container',
  apiBaseUrl: 'http://localhost:8081',
  onNodeClick: node => {
    document.getElementById('details').innerHTML = `
      <h3>${node.displayName}</h3>
      <p><strong>DN:</strong> ${node.dn}</p>
      <p><strong>Type:</strong> ${node.type}</p>
      <p><strong>Children:</strong> ${node.childrenDns.length}</p>
    `;
  },
});

await viewer.init();

// Search functionality
document.getElementById('search').addEventListener('input', e => {
  const matches = highlightNodes(viewer, e.target.value);
  console.log(`Found ${matches.length} matches`);
});
```

#### Integration with Custom UI

```javascript
const viewer = new LdapTreeViewer({
  containerId: 'tree-container',
  apiBaseUrl: 'http://localhost:8081',
  onNodeClick: async node => {
    // Show loading state
    document.getElementById('sidebar').classList.add('loading');

    // Fetch additional data
    const response = await fetch(
      `${viewer.options.apiBaseUrl}/api/v1/ldap/organizations/${encodeURIComponent(node.dn)}`
    );
    const data = await response.json();

    // Update custom UI
    updateSidebar(data);

    // Hide loading state
    document.getElementById('sidebar').classList.remove('loading');
  },
  onNodeExpand: node => {
    // Track analytics
    analytics.track('Organization Expanded', {
      dn: node.dn,
      name: node.displayName,
    });
  },
});

await viewer.init();
```

---

## LdapUserEditor

A complete user management interface with organization tree, user list, and edit form.

<a name="ldapusereditor-installation"></a>

### Installation

#### With a Bundler (Webpack, Vite, Rollup, etc.)

```bash
npm install ldap-rest
```

```typescript
import LdapUserEditor from 'ldap-rest/browser-ldap-user-editor-index';
// Don't forget to include Roboto font and Material Icons in your HTML
```

#### Direct Browser Usage

Include the required dependencies in your HTML:

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- Google Fonts - Roboto (required) -->
    <link
      href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap"
      rel="stylesheet"
    />

    <!-- Material Icons (required) -->
    <link
      href="https://fonts.googleapis.com/icon?family=Material+Icons"
      rel="stylesheet"
    />

    <!-- LdapUserEditor CSS -->
    <link
      rel="stylesheet"
      href="/static/browser/ldap-user-editor/LdapUserEditor.css"
    />
  </head>
  <body>
    <div id="editor-container"></div>

    <!-- LdapUserEditor JavaScript -->
    <script src="/static/browser/ldap-user-editor/LdapUserEditor.js"></script>
  </body>
</html>
```

<a name="ldapusereditor-basic-usage"></a>

### Basic Usage

#### With ES Modules

```typescript
import LdapUserEditor from 'ldap-rest/browser-ldap-user-editor-index';

// Create and initialize the editor
const editor = new LdapUserEditor({
  containerId: 'editor-container',
  apiBaseUrl: 'http://localhost:8081',
  onUserSaved: userDn => {
    console.log('User saved:', userDn);
  },
  onError: error => {
    console.error('Editor error:', error);
  },
});

// Initialize the editor
await editor.init();
```

#### With UMD (Direct Browser)

```javascript
// Access the library from window
const { LdapUserEditor } = window.LdapUserEditor;

// Create and initialize the editor
const editor = new LdapUserEditor({
  containerId: 'editor-container',
  apiBaseUrl: 'http://localhost:8081',
  onUserSaved: userDn => {
    console.log('User saved:', userDn);
  },
  onError: error => {
    console.error('Editor error:', error);
  },
});

// Initialize the editor
await editor.init();
```

<a name="ldapusereditor-configuration-options"></a>

### Configuration Options

The `EditorOptions` interface defines all available configuration options:

```typescript
interface EditorOptions {
  // Required: ID of the HTML container element
  containerId: string;

  // Optional: Base URL of the LDAP-Rest API (defaults to current origin)
  apiBaseUrl?: string;

  // Optional: Callback when a user is saved
  onUserSaved?: (userDn: string) => void;

  // Optional: Callback for error handling
  onError?: (error: Error) => void;
}
```

**Example with all options:**

```javascript
const editor = new LdapUserEditor({
  containerId: 'editor-container',
  apiBaseUrl: 'http://localhost:8081',
  onUserSaved: userDn => {
    // Show success notification
    showNotification('User saved successfully!', 'success');

    // Refresh external data
    refreshDashboard();

    // Log activity
    logActivity('user_updated', userDn);
  },
  onError: error => {
    // Show error notification
    showNotification(`Error: ${error.message}`, 'error');

    // Log error to monitoring service
    errorTracker.captureException(error);
  },
});

await editor.init();
```

<a name="ldapusereditor-public-methods"></a>

### Public Methods

#### `async init(): Promise<void>`

Initializes the editor and loads the organization tree.

```javascript
const editor = new LdapUserEditor({
  containerId: 'editor-container',
  apiBaseUrl: 'http://localhost:8081',
});

await editor.init();
```

#### `async refresh(): Promise<void>`

Refreshes the organization tree and currently displayed user data.

```javascript
await editor.refresh();
```

#### `destroy(): void`

Cleans up the editor and removes it from the DOM.

```javascript
editor.destroy();
```

<a name="ldapusereditor-features"></a>

### Features

The LdapUserEditor provides a complete user management interface with three main components:

#### 1. Organization Tree

- **Hierarchical navigation** - Browse LDAP organizations in a tree structure
- **Visual indicators** - Material Icons for different node types
- **Expand/collapse** - Load children on demand
- **Selection highlighting** - Visual feedback for selected organization

#### 2. User List

- **Filtered by organization** - Shows users in the selected organization
- **User details** - Displays name and email for each user
- **Click to edit** - Select a user to open the edit form
- **Material Design** - Clean, modern list interface

#### 3. Edit Form

- **Schema-driven** - Automatically generated from JSON schema
- **Field validation** - Required fields, regex patterns, custom validation
- **Field groups** - Organized sections for better UX
- **Multiple input types** - Text, email, select, arrays
- **Save/Cancel actions** - With loading states and error handling
- **Real-time feedback** - Success/error messages

**Complete Example:**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>User Management</title>

    <link
      href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap"
      rel="stylesheet"
    />
    <link
      href="https://fonts.googleapis.com/icon?family=Material+Icons"
      rel="stylesheet"
    />
    <link
      rel="stylesheet"
      href="/static/browser/ldap-user-editor/LdapUserEditor.css"
    />

    <style>
      body {
        margin: 0;
        padding: 20px;
        background: #f5f5f5;
        font-family: 'Roboto', sans-serif;
      }

      .container {
        max-width: 1400px;
        margin: 0 auto;
      }

      h1 {
        color: #333;
        margin-bottom: 20px;
      }

      #editor-container {
        background: white;
        border-radius: 8px;
        padding: 24px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>User Management System</h1>
      <div id="editor-container"></div>
    </div>

    <script src="/static/browser/ldap-user-editor/LdapUserEditor.js"></script>
    <script>
      const { LdapUserEditor } = window.LdapUserEditor;

      const editor = new LdapUserEditor({
        containerId: 'editor-container',
        apiBaseUrl: window.location.origin,
        onUserSaved: userDn => {
          console.log('User saved successfully:', userDn);
        },
        onError: error => {
          console.error('Error:', error.message);
        },
      });

      editor.init().catch(error => {
        console.error('Failed to initialize editor:', error);
      });
    </script>
  </body>
</html>
```

<a name="ldapusereditor-css-customization"></a>

### CSS Customization

The LdapUserEditor uses CSS variables for easy customization. Override these variables in your stylesheet:

```css
:root {
  /* Primary colors */
  --primary-color: #6200ee;
  --primary-dark: #3700b3;
  --success-color: #2e7d32;
  --error-color: #c62828;

  /* Background colors */
  --bg-color: #f8fafc;
  --surface-color: #ffffff;

  /* Text colors */
  --text-primary: #1e293b;
  --text-secondary: #64748b;

  /* Border color */
  --border-color: #e2e8f0;
}
```

**Example - Custom Theme:**

```css
/* Dark theme customization */
:root {
  --primary-color: #bb86fc;
  --primary-dark: #9965f4;
  --success-color: #4caf50;
  --error-color: #ef5350;

  --bg-color: #121212;
  --surface-color: #1e1e1e;

  --text-primary: #ffffff;
  --text-secondary: #b0b0b0;

  --border-color: #333333;
}
```

**Example - Custom Branding:**

```css
/* Company branding */
:root {
  --primary-color: #ff6b35; /* Your brand color */
  --primary-dark: #d45426;
  --success-color: #28a745;
  --error-color: #dc3545;
}

/* Custom button styles */
.btn {
  border-radius: 20px; /* Rounded buttons */
  text-transform: none; /* No uppercase */
  font-weight: 600;
}

/* Custom panel styles */
.demo-panel {
  border-radius: 12px; /* More rounded */
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.15);
}

/* Custom tree node hover */
.tree-node:hover {
  background: linear-gradient(90deg, var(--bg-color) 0%, transparent 100%);
}
```

**Example - Compact Layout:**

```css
/* Smaller, more compact layout */
.editor-layout {
  gap: 16px; /* Less spacing */
}

.demo-panel {
  padding: 16px; /* Less padding */
  max-height: 600px; /* Smaller height */
}

.form-row {
  gap: 1rem; /* Tighter form spacing */
  margin-bottom: 1rem;
}

.form-input,
.form-select {
  padding: 0.5rem 0.625rem; /* Smaller inputs */
  font-size: 0.8125rem;
}
```

**Example - Accessibility Enhancements:**

```css
/* High contrast mode */
@media (prefers-contrast: high) {
  :root {
    --border-color: #000000;
    --text-primary: #000000;
    --text-secondary: #333333;
  }

  .form-input:focus,
  .form-select:focus {
    border-width: 2px;
    border-color: #000000;
  }
}

/* Larger text for accessibility */
.ldap-user-editor {
  font-size: 16px; /* Larger base font */
}

.form-label {
  font-weight: 600; /* Bolder labels */
}

/* Better focus indicators */
.btn:focus,
.form-input:focus,
.form-select:focus {
  outline: 3px solid var(--primary-color);
  outline-offset: 2px;
}
```

---

## LdapUnitEditor

A complete organizational unit (OU) management interface with tree navigation, create, move, edit, and delete operations.

<a name="ldapuniteditor-installation"></a>

### Installation

#### Direct Browser Usage

Include the required dependencies in your HTML:

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- Google Fonts - Roboto (required) -->
    <link
      href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap"
      rel="stylesheet"
    />

    <!-- Material Icons (required) -->
    <link
      href="https://fonts.googleapis.com/icon?family=Material+Icons"
      rel="stylesheet"
    />

    <!-- Shared CSS (required) -->
    <link rel="stylesheet" href="/static/browser/common-demo.css" />
  </head>
  <body>
    <div id="editor-container"></div>

    <!-- LdapUnitEditor JavaScript -->
    <script src="/static/browser/ldap-unit-editor.js"></script>
  </body>
</html>
```

<a name="ldapuniteditor-basic-usage"></a>

### Basic Usage

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Organization Management</title>

    <link
      href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap"
      rel="stylesheet"
    />
    <link
      href="https://fonts.googleapis.com/icon?family=Material+Icons"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/static/browser/common-demo.css" />
  </head>
  <body>
    <div class="demo-container">
      <header class="demo-header">
        <h1>Organization Management</h1>
        <p>Create, edit, move, and delete organizational units</p>
      </header>
      <div id="editor-container"></div>
    </div>

    <script src="/static/browser/ldap-unit-editor.js"></script>
    <script>
      const { LdapUnitEditor } = window.LdapUnitEditor;

      const editor = new LdapUnitEditor({
        containerId: 'editor-container',
        apiBaseUrl: window.location.origin,
      });

      editor.init().catch(error => {
        console.error('Failed to initialize editor:', error);
      });
    </script>
  </body>
</html>
```

<a name="ldapuniteditor-features"></a>

### Features

The LdapUnitEditor provides a complete organization management interface with two main panels:

#### 1. Organization Tree Panel

- **Hierarchical navigation** - Browse LDAP organizations in an expandable tree structure
- **Material Icons** - Visual indicators with business icons
- **Create button** - Quickly create new sub-organizations under selected unit
- **Click to edit** - Select an organization to view and edit its properties
- **Automatic expansion** - Tree expands to show newly created organizations

**Features:**

- Create new organizational units under any parent organization
- Prompts for OU name with validation
- Automatically expands parent after creation
- Refreshes tree to show new structure

#### 2. Property Editor Panel

- **Schema-driven forms** - Automatically generated from JSON schema
- **Field validation** - Required fields, type checking
- **Field groups** - Organized into "Basic Information" and "Additional Properties"
- **Move operation** - Relocate organizations to different parents with modal tree picker
- **Delete protection** - Automatically disables delete button when organization has sub-organizations
- **Real-time feedback** - Success/error messages via alerts

**Features:**

- **Edit Properties**: Modify OU name, description, and custom attributes
- **Move Organization**:
  - Opens modal with organization tree
  - Cannot move into itself or descendants (circular reference prevention)
  - Shows current organization as disabled in the tree
  - Updates DN automatically after move
- **Delete Organization**:
  - Button disabled when organization contains sub-organizations
  - Visual indication (grayed out, cursor not-allowed)
  - Tooltip explaining why deletion is blocked
  - Confirmation dialog before deletion
- **Validation**: All changes validated against configured schema

#### 3. Move Modal

When clicking the "Move" button, a modal dialog appears with:

- **Organization tree picker** - Navigate and select target parent organization
- **Visual feedback** - Current organization shown as disabled
- **Expand/collapse** - Load children on demand
- **Selection highlighting** - Clear visual indication of selected target
- **Circular move prevention** - Cannot select current org or its descendants
- **Cancel/Move actions** - Confirm or cancel the move operation

**Example Move Operation:**

```
Original: ou=Recruitment,ou=HR,dc=example,dc=com
Target:   ou=Operations,dc=example,dc=com
Result:   ou=Recruitment,ou=Operations,dc=example,dc=com
```

All users, groups, and sub-organizations linked to the moved unit automatically update their references.

### Usage Example

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LDAP Organization Manager</title>

    <!-- Required fonts and icons -->
    <link
      href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap"
      rel="stylesheet"
    />
    <link
      href="https://fonts.googleapis.com/icon?family=Material+Icons"
      rel="stylesheet"
    />

    <!-- Shared CSS -->
    <link rel="stylesheet" href="/static/browser/common-demo.css" />

    <style>
      body {
        margin: 0;
        padding: 0;
        background: #f5f5f5;
        font-family: 'Roboto', sans-serif;
      }

      .demo-container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 20px;
      }

      .demo-header {
        background: white;
        padding: 24px;
        border-radius: 8px;
        margin-bottom: 20px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }

      .demo-header h1 {
        margin: 0 0 8px 0;
        color: var(--primary-color, #6200ee);
      }

      .demo-header p {
        margin: 0;
        color: #666;
      }

      #editor-container {
        background: white;
        border-radius: 8px;
        padding: 24px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        min-height: 600px;
      }
    </style>
  </head>
  <body>
    <div class="demo-container">
      <header class="demo-header">
        <h1>Organization Management System</h1>
        <p>
          Manage your LDAP organizational structure - Create, edit, move, and
          delete organizational units
        </p>
      </header>

      <div id="editor-container"></div>
    </div>

    <script src="/static/browser/ldap-unit-editor.js"></script>
    <script>
      const { LdapUnitEditor } = window.LdapUnitEditor;

      const editor = new LdapUnitEditor({
        containerId: 'editor-container',
        apiBaseUrl: window.location.origin,
      });

      editor.init().catch(error => {
        console.error('Failed to initialize organization editor:', error);
        document.getElementById('editor-container').innerHTML = `
          <div style="color: #c62828; padding: 20px; text-align: center;">
            <p style="font-size: 18px; margin: 0;">Failed to load editor</p>
            <p style="margin: 8px 0 0 0;">${error.message}</p>
          </div>
        `;
      });
    </script>
  </body>
</html>
```

### API Requirements

The LdapUnitEditor requires the following LDAP-Rest API endpoints:

- `GET /api/v1/config` - Configuration and schema
- `GET /api/v1/ldap/organizations/top` - Top organization
- `GET /api/v1/ldap/organizations/:dn` - Get organization details
- `GET /api/v1/ldap/organizations/:dn/subnodes` - Get child organizations
- `POST /api/v1/ldap/organizations` - Create new organization
- `PUT /api/v1/ldap/organizations/:dn` - Update organization
- `POST /api/v1/ldap/organizations/:dn/move` - Move organization to new parent
- `DELETE /api/v1/ldap/organizations/:dn` - Delete organization

See [LDAP Organizations Plugin Documentation](../ldapOrganizations.md) for API details.

---

## Next Steps

- **[REST API Documentation](../api/REST_API.md)** - Learn about the underlying API
- **[Integration Examples](../examples/EXAMPLES.md)** - See real-world integration examples
- **[JSON Schemas Guide](../schemas/SCHEMAS.md)** - Understand schema-driven architecture
- **[LDAP Organizations Plugin](../ldapOrganizations.md)** - Learn about organization management

---

## Resources

- [GitHub Repository](https://github.com/linagora/ldap-rest)
- [Developer Guide](../DEVELOPER_GUIDE.md)
- [API Reference](../api/REFERENCE.md)

---

## License

AGPL-3.0 - Copyright 2025-present LINAGORA
