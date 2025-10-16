# Integration Examples - LDAP-Rest

This guide provides complete, production-ready examples for integrating LDAP-Rest into your applications using React, Vue.js, and Vanilla JavaScript.

## Table of Contents

- [React Application Example](#react-application-example)
- [Vue.js Application Example](#vuejs-application-example)
- [Vanilla JavaScript with TreeViewer](#vanilla-javascript-with-treeviewer)
- [Group Management Application](#group-management-application)

---

## React Application Example

This example demonstrates a complete React functional component that fetches users from LDAP-Rest and displays them in a list.

### Complete React Component

```jsx
import React, { useState, useEffect } from 'react';

const UserManager = () => {
  const [users, setUsers] = useState([]);
  const [config, setConfig] = useState(null);
  const [usersEndpoint, setUsersEndpoint] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load configuration on component mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch('http://localhost:8081/api/v1/config');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const configData = await response.json();
        setConfig(configData);

        // Discover users endpoint from config
        const userResource = configData.features?.flatResources?.find(
          r => r.pluralName === 'users'
        );

        if (!userResource) {
          throw new Error('Users endpoint not found in configuration');
        }

        setUsersEndpoint(userResource.endpoints.list);
      } catch (err) {
        console.error('Failed to load config:', err);
        setError(err.message);
        setLoading(false);
      }
    };

    loadConfig();
  }, []);

  // Load users when endpoint is discovered
  useEffect(() => {
    if (!usersEndpoint) return;

    const loadUsers = async () => {
      try {
        setLoading(true);
        const response = await fetch(usersEndpoint);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const usersData = await response.json();
        setUsers(usersData);
        setError(null);
      } catch (err) {
        console.error('Failed to load users:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    loadUsers();
  }, [usersEndpoint]);

  // Error state
  if (error) {
    return (
      <div className="error-container">
        <h2>Error</h2>
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading users...</p>
      </div>
    );
  }

  // Success state - display users
  return (
    <div className="user-manager">
      <header className="header">
        <h1>User Management</h1>
        <p className="subtitle">
          Managing {users.length} users in {config?.ldapBase}
        </p>
      </header>

      <div className="user-list">
        {users.length === 0 ? (
          <div className="empty-state">
            <p>No users found</p>
          </div>
        ) : (
          <table className="user-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Full Name</th>
                <th>Email</th>
                <th>DN</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.dn}>
                  <td className="username">{user.uid}</td>
                  <td>{user.cn}</td>
                  <td>
                    {user.mail ? (
                      <a href={`mailto:${user.mail}`}>{user.mail}</a>
                    ) : (
                      <span className="no-email">No email</span>
                    )}
                  </td>
                  <td className="dn">{user.dn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default UserManager;
```

### Styles (Optional)

```css
.user-manager {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

.header {
  margin-bottom: 2rem;
  border-bottom: 2px solid #e2e8f0;
  padding-bottom: 1rem;
}

.header h1 {
  margin: 0 0 0.5rem 0;
  color: #1e293b;
}

.subtitle {
  color: #64748b;
  margin: 0;
}

.loading-container,
.error-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 400px;
  gap: 1rem;
}

.spinner {
  width: 50px;
  height: 50px;
  border: 4px solid #e2e8f0;
  border-top-color: #6200ee;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-container {
  color: #c62828;
}

.error-container button {
  padding: 0.5rem 1rem;
  background: #6200ee;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.user-table {
  width: 100%;
  border-collapse: collapse;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.user-table th,
.user-table td {
  padding: 1rem;
  text-align: left;
  border-bottom: 1px solid #e2e8f0;
}

.user-table th {
  background: #f8fafc;
  font-weight: 600;
  color: #1e293b;
}

.user-table tr:hover {
  background: #f8fafc;
}

.username {
  font-family: monospace;
  font-weight: 600;
}

.dn {
  font-family: monospace;
  font-size: 0.875rem;
  color: #64748b;
}

.no-email {
  color: #94a3b8;
  font-style: italic;
}

.empty-state {
  text-align: center;
  padding: 3rem;
  color: #64748b;
}
```

### Usage

```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import UserManager from './UserManager';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <UserManager />
  </React.StrictMode>
);
```

---

## Vue.js Application Example

This example shows a complete Vue.js component using the LdapUserEditor library with proper lifecycle management and toast notifications.

### Complete Vue Component

```vue
<template>
  <div class="ldap-editor-wrapper">
    <header class="app-header">
      <h1>LDAP User Editor</h1>
      <p class="subtitle">Manage your organization's users</p>
    </header>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>Initializing editor...</p>
    </div>

    <div v-else-if="error" class="error-state">
      <span class="material-icons">error_outline</span>
      <h2>Failed to Initialize</h2>
      <p>{{ error }}</p>
      <button @click="retryInit" class="retry-btn">Retry</button>
    </div>

    <div v-else id="editor-container" class="editor-container"></div>

    <!-- Toast Notifications -->
    <Transition name="toast">
      <div v-if="toast.visible" :class="['toast', `toast-${toast.type}`]">
        <span class="material-icons">{{ getToastIcon(toast.type) }}</span>
        <span class="toast-message">{{ toast.message }}</span>
      </div>
    </Transition>
  </div>
</template>

<script>
export default {
  name: 'LdapEditorApp',

  data() {
    return {
      editor: null,
      loading: true,
      error: null,
      toast: {
        visible: false,
        message: '',
        type: 'info', // 'success', 'error', 'info', 'warning'
      },
    };
  },

  mounted() {
    this.initEditor();
  },

  beforeUnmount() {
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
  },

  methods: {
    async initEditor() {
      try {
        this.loading = true;
        this.error = null;

        // Load LdapUserEditor library
        const { LdapUserEditor } = window.LdapUserEditor;

        if (!LdapUserEditor) {
          throw new Error('LdapUserEditor library not loaded');
        }

        // Create editor instance
        this.editor = new LdapUserEditor({
          containerId: 'editor-container',
          apiBaseUrl: window.location.origin,
          onUserSaved: this.handleUserSaved,
          onError: this.handleError,
        });

        // Initialize the editor
        await this.editor.init();

        this.loading = false;
        this.showToast('Editor initialized successfully', 'success');
      } catch (err) {
        console.error('Failed to initialize editor:', err);
        this.error = err.message || 'Unknown error occurred';
        this.loading = false;
        this.showToast('Failed to initialize editor', 'error');
      }
    },

    handleUserSaved(userDn) {
      console.log('User saved:', userDn);
      this.showToast('User saved successfully!', 'success');

      // Optional: Track analytics
      if (window.gtag) {
        window.gtag('event', 'user_updated', {
          event_category: 'ldap',
          event_label: userDn,
        });
      }
    },

    handleError(error) {
      console.error('Editor error:', error);
      this.showToast(error.message || 'An error occurred', 'error');
    },

    retryInit() {
      this.initEditor();
    },

    showToast(message, type = 'info') {
      this.toast = {
        visible: true,
        message,
        type,
      };

      // Auto-hide after 3 seconds
      setTimeout(() => {
        this.toast.visible = false;
      }, 3000);
    },

    getToastIcon(type) {
      const icons = {
        success: 'check_circle',
        error: 'error',
        warning: 'warning',
        info: 'info',
      };
      return icons[type] || 'info';
    },
  },
};
</script>

<style scoped>
.ldap-editor-wrapper {
  min-height: 100vh;
  background: #f5f5f5;
}

.app-header {
  background: white;
  padding: 2rem;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  margin-bottom: 2rem;
}

.app-header h1 {
  margin: 0 0 0.5rem 0;
  color: #1e293b;
  font-size: 2rem;
}

.subtitle {
  margin: 0;
  color: #64748b;
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 400px;
  gap: 1rem;
  text-align: center;
}

.spinner {
  width: 50px;
  height: 50px;
  border: 4px solid #e2e8f0;
  border-top-color: #6200ee;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-state {
  color: #c62828;
}

.error-state .material-icons {
  font-size: 64px;
}

.retry-btn {
  padding: 0.75rem 1.5rem;
  background: #6200ee;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.2s;
}

.retry-btn:hover {
  background: #3700b3;
}

.editor-container {
  padding: 2rem;
}

/* Toast Notifications */
.toast {
  position: fixed;
  bottom: 2rem;
  right: 2rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.5rem;
  background: white;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  min-width: 300px;
}

.toast-success {
  border-left: 4px solid #2e7d32;
}

.toast-success .material-icons {
  color: #2e7d32;
}

.toast-error {
  border-left: 4px solid #c62828;
}

.toast-error .material-icons {
  color: #c62828;
}

.toast-warning {
  border-left: 4px solid #f57c00;
}

.toast-warning .material-icons {
  color: #f57c00;
}

.toast-info {
  border-left: 4px solid #1976d2;
}

.toast-info .material-icons {
  color: #1976d2;
}

.toast-message {
  flex: 1;
  color: #1e293b;
}

/* Toast Transitions */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  transform: translateX(400px);
  opacity: 0;
}
</style>
```

### HTML Template

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LDAP User Editor - Vue.js</title>

    <!-- Google Fonts -->
    <link
      href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap"
      rel="stylesheet"
    />
    <link
      href="https://fonts.googleapis.com/icon?family=Material+Icons"
      rel="stylesheet"
    />

    <!-- LdapUserEditor CSS -->
    <link
      rel="stylesheet"
      href="/static/browser/ldap-user-editor/LdapUserEditor.css"
    />

    <!-- Vue.js (Development version) -->
    <script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js"></script>

    <style>
      body {
        margin: 0;
        font-family: 'Roboto', sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="app"></div>

    <!-- LdapUserEditor JavaScript -->
    <script src="/static/browser/ldap-user-editor/LdapUserEditor.js"></script>

    <!-- Your Vue App -->
    <script src="./app.js"></script>
  </body>
</html>
```

### App Entry Point (app.js)

```javascript
const { createApp } = Vue;
import LdapEditorApp from './LdapEditorApp.vue';

createApp(LdapEditorApp).mount('#app');
```

---

## Vanilla JavaScript with TreeViewer

This example demonstrates a complete HTML page with sidebar tree navigation and content area for displaying node details.

### Complete HTML Page

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Organization Browser - LDAP-Rest</title>

    <!-- Material Icons -->
    <link
      href="https://fonts.googleapis.com/icon?family=Material+Icons"
      rel="stylesheet"
    />

    <!-- LdapTreeViewer CSS -->
    <link
      rel="stylesheet"
      href="/static/browser/ldap-tree-viewer/LdapTreeViewer.css"
    />

    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        font-family:
          -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu,
          Cantarell, sans-serif;
        background: #f5f5f5;
        color: #333;
      }

      .app-container {
        display: flex;
        height: 100vh;
        overflow: hidden;
      }

      /* Sidebar with Tree */
      .sidebar {
        width: 350px;
        background: white;
        border-right: 1px solid #e0e0e0;
        display: flex;
        flex-direction: column;
      }

      .sidebar-header {
        padding: 1.5rem;
        background: #6200ee;
        color: white;
      }

      .sidebar-header h1 {
        font-size: 1.25rem;
        margin-bottom: 0.25rem;
      }

      .sidebar-header p {
        font-size: 0.875rem;
        opacity: 0.9;
      }

      .tree-container {
        flex: 1;
        overflow-y: auto;
        padding: 1rem;
      }

      /* Main Content Area */
      .content-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .content-header {
        padding: 1.5rem 2rem;
        background: white;
        border-bottom: 1px solid #e0e0e0;
      }

      .content-header h2 {
        font-size: 1.5rem;
        color: #1e293b;
      }

      .content-body {
        flex: 1;
        overflow-y: auto;
        padding: 2rem;
      }

      .node-details {
        background: white;
        border-radius: 8px;
        padding: 2rem;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: #64748b;
        text-align: center;
      }

      .empty-state .material-icons {
        font-size: 80px;
        margin-bottom: 1rem;
        opacity: 0.5;
      }

      .node-type-badge {
        display: inline-block;
        padding: 0.25rem 0.75rem;
        border-radius: 12px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        margin-bottom: 1rem;
      }

      .node-type-organization {
        background: #e3f2fd;
        color: #1976d2;
      }

      .node-type-user {
        background: #f3e5f5;
        color: #7b1fa2;
      }

      .node-type-group {
        background: #e8f5e9;
        color: #388e3c;
      }

      .detail-section {
        margin-bottom: 2rem;
      }

      .detail-section h3 {
        font-size: 1rem;
        color: #64748b;
        margin-bottom: 1rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
      }

      .detail-row {
        display: flex;
        padding: 0.75rem 0;
        border-bottom: 1px solid #f1f5f9;
      }

      .detail-row:last-child {
        border-bottom: none;
      }

      .detail-label {
        width: 200px;
        font-weight: 600;
        color: #475569;
      }

      .detail-value {
        flex: 1;
        color: #1e293b;
        word-break: break-all;
      }

      .detail-value code {
        background: #f1f5f9;
        padding: 0.125rem 0.375rem;
        border-radius: 3px;
        font-family: 'Courier New', monospace;
        font-size: 0.875rem;
      }

      .children-list {
        list-style: none;
      }

      .children-list li {
        padding: 0.5rem 0;
        color: #1e293b;
      }

      .children-list li::before {
        content: '→';
        margin-right: 0.5rem;
        color: #6200ee;
        font-weight: bold;
      }

      .loading-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(255, 255, 255, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
      }

      .spinner {
        width: 50px;
        height: 50px;
        border: 4px solid #e0e0e0;
        border-top-color: #6200ee;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  </head>
  <body>
    <div class="app-container">
      <!-- Sidebar with Tree -->
      <aside class="sidebar">
        <div class="sidebar-header">
          <h1>Organizations</h1>
          <p>Browse your LDAP directory</p>
        </div>
        <div id="tree" class="tree-container"></div>
      </aside>

      <!-- Main Content Area -->
      <main class="content-area">
        <div class="content-header">
          <h2>Node Details</h2>
        </div>
        <div class="content-body">
          <div id="details" class="empty-state">
            <span class="material-icons">account_tree</span>
            <p>Select a node from the tree to view details</p>
          </div>
        </div>
      </main>
    </div>

    <!-- LdapTreeViewer JavaScript -->
    <script src="/static/browser/ldap-tree-viewer/LdapTreeViewer.js"></script>

    <script>
      const { LdapTreeViewer } = window.LdapTreeViewer;

      // Initialize the tree viewer
      const viewer = new LdapTreeViewer({
        containerId: 'tree',
        apiBaseUrl: window.location.origin,
        onNodeClick: handleNodeClick,
        onNodeExpand: handleNodeExpand,
      });

      // Handle node clicks
      async function handleNodeClick(node) {
        const detailsContainer = document.getElementById('details');

        // Show loading state
        detailsContainer.innerHTML = `
        <div class="loading-overlay">
          <div class="spinner"></div>
        </div>
      `;

        try {
          // Fetch full node details
          const apiUrl = `${viewer.options.apiBaseUrl}/api/v1/ldap/organizations/${encodeURIComponent(node.dn)}`;
          const response = await fetch(apiUrl);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const nodeData = await response.json();

          // Display node details
          displayNodeDetails(node, nodeData);
        } catch (error) {
          console.error('Failed to load node details:', error);
          detailsContainer.innerHTML = `
          <div class="empty-state">
            <span class="material-icons">error_outline</span>
            <p>Failed to load node details</p>
            <p style="font-size: 0.875rem; margin-top: 0.5rem;">${error.message}</p>
          </div>
        `;
        }
      }

      // Handle node expansion
      function handleNodeExpand(node) {
        console.log(
          'Node expanded:',
          node.displayName,
          '(',
          node.childrenDns.length,
          'children)'
        );
      }

      // Display node details in the content area
      function displayNodeDetails(node, fullData) {
        const detailsContainer = document.getElementById('details');

        // Build attributes list
        const attributesHtml = Object.entries(fullData)
          .filter(([key]) => key !== 'dn')
          .map(([key, value]) => {
            const displayValue = Array.isArray(value)
              ? value.join(', ')
              : String(value);

            return `
            <div class="detail-row">
              <div class="detail-label">${key}</div>
              <div class="detail-value"><code>${escapeHtml(displayValue)}</code></div>
            </div>
          `;
          })
          .join('');

        // Build children list
        const childrenHtml =
          node.childrenDns.length > 0
            ? `
          <div class="detail-section">
            <h3>Children (${node.childrenDns.length})</h3>
            <ul class="children-list">
              ${node.childrenDns
                .slice(0, 10)
                .map(dn => `<li>${escapeHtml(dn)}</li>`)
                .join('')}
              ${node.childrenDns.length > 10 ? `<li>... and ${node.childrenDns.length - 10} more</li>` : ''}
            </ul>
          </div>
        `
            : '';

        detailsContainer.innerHTML = `
        <div class="node-details">
          <span class="node-type-badge node-type-${node.type}">${node.type}</span>
          <h2 style="margin-bottom: 0.5rem;">${escapeHtml(node.displayName)}</h2>
          <p style="color: #64748b; font-family: monospace; font-size: 0.875rem; margin-bottom: 2rem;">
            ${escapeHtml(node.dn)}
          </p>

          <div class="detail-section">
            <h3>Attributes</h3>
            ${attributesHtml}
          </div>

          ${childrenHtml}
        </div>
      `;
      }

      // Utility function to escape HTML
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      // Initialize the viewer
      viewer.init().catch(error => {
        console.error('Failed to initialize tree viewer:', error);
        document.getElementById('tree').innerHTML = `
        <div style="padding: 1rem; color: #c62828; text-align: center;">
          <p><strong>Failed to initialize</strong></p>
          <p style="font-size: 0.875rem; margin-top: 0.5rem;">${error.message}</p>
        </div>
      `;
      });
    </script>
  </body>
</html>
```

---

## Group Management Application

This example demonstrates a complete class-based group management application with initialization, group operations, and member management.

### Complete GroupManager Class

```javascript
/**
 * GroupManager - Complete group management application
 * Provides methods for listing, creating, and managing LDAP groups
 */
class GroupManager {
  constructor(apiBaseUrl = window.location.origin) {
    this.apiBaseUrl = apiBaseUrl;
    this.config = null;
    this.groupsEndpoint = null;
    this.groupsBase = null;
  }

  /**
   * Initialize the manager by loading configuration
   */
  async init() {
    try {
      // Load configuration from API
      const response = await fetch(`${this.apiBaseUrl}/api/v1/config`);
      if (!response.ok) {
        throw new Error(`Failed to load config: ${response.status}`);
      }

      this.config = await response.json();

      // Discover groups endpoints from config
      const groupsConfig = this.config.features?.groups;
      if (!groupsConfig || !groupsConfig.enabled) {
        throw new Error(
          'Groups feature is not enabled in LDAP-Rest configuration'
        );
      }

      this.groupsEndpoint = groupsConfig.endpoints;
      this.groupsBase = groupsConfig.base;

      console.log('GroupManager initialized successfully');
      console.log('Groups base:', this.groupsBase);

      return true;
    } catch (error) {
      console.error('Failed to initialize GroupManager:', error);
      throw error;
    }
  }

  /**
   * List all groups or filter by name pattern
   * @param {string} matchPattern - Optional pattern to filter groups (e.g., "admin*")
   * @returns {Promise<Object>} Object with group CNs as keys and group data as values
   */
  async listGroups(matchPattern = null) {
    if (!this.groupsEndpoint) {
      throw new Error('GroupManager not initialized. Call init() first.');
    }

    try {
      let url = this.groupsEndpoint.list;

      // Add filter if provided
      if (matchPattern) {
        url += `?match=${encodeURIComponent(matchPattern)}`;
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to list groups: ${response.status}`);
      }

      const groups = await response.json();
      console.log(`Found ${Object.keys(groups).length} groups`);

      return groups;
    } catch (error) {
      console.error('Error listing groups:', error);
      throw error;
    }
  }

  /**
   * Get a specific group by CN
   * @param {string} cn - Group common name
   * @returns {Promise<Object>} Group data
   */
  async getGroup(cn) {
    if (!this.groupsEndpoint) {
      throw new Error('GroupManager not initialized. Call init() first.');
    }

    try {
      const url = this.groupsEndpoint.get.replace(
        ':cn',
        encodeURIComponent(cn)
      );
      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Group "${cn}" not found`);
        }
        throw new Error(`Failed to get group: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error getting group "${cn}":`, error);
      throw error;
    }
  }

  /**
   * Create a new group
   * @param {string} cn - Group common name
   * @param {Object} options - Additional group options
   * @param {string[]} options.members - Array of member DNs
   * @param {string} options.description - Group description
   * @returns {Promise<Object>} Response with success status and DN
   */
  async createGroup(cn, options = {}) {
    if (!this.groupsEndpoint) {
      throw new Error('GroupManager not initialized. Call init() first.');
    }

    try {
      const groupData = {
        cn: cn,
        ...options,
      };

      const response = await fetch(this.groupsEndpoint.create, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(groupData),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to create group: ${response.status}`
        );
      }

      const result = await response.json();
      console.log(`Group "${cn}" created successfully:`, result.dn);

      return result;
    } catch (error) {
      console.error(`Error creating group "${cn}":`, error);
      throw error;
    }
  }

  /**
   * Update a group's attributes
   * @param {string} cn - Group common name
   * @param {Object} changes - LDAP modify operations (replace, add, delete)
   * @returns {Promise<Object>} Response with success status
   */
  async updateGroup(cn, changes) {
    if (!this.groupsEndpoint) {
      throw new Error('GroupManager not initialized. Call init() first.');
    }

    try {
      const url = this.groupsEndpoint.update.replace(
        ':cn',
        encodeURIComponent(cn)
      );
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(changes),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to update group: ${response.status}`
        );
      }

      const result = await response.json();
      console.log(`Group "${cn}" updated successfully`);

      return result;
    } catch (error) {
      console.error(`Error updating group "${cn}":`, error);
      throw error;
    }
  }

  /**
   * Delete a group
   * @param {string} cn - Group common name
   * @returns {Promise<Object>} Response with success status
   */
  async deleteGroup(cn) {
    if (!this.groupsEndpoint) {
      throw new Error('GroupManager not initialized. Call init() first.');
    }

    try {
      const url = this.groupsEndpoint.delete.replace(
        ':cn',
        encodeURIComponent(cn)
      );
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to delete group: ${response.status}`
        );
      }

      const result = await response.json();
      console.log(`Group "${cn}" deleted successfully`);

      return result;
    } catch (error) {
      console.error(`Error deleting group "${cn}":`, error);
      throw error;
    }
  }

  /**
   * Add a member to a group
   * @param {string} groupCn - Group common name
   * @param {string|string[]} memberDn - Member DN(s) to add
   * @returns {Promise<Object>} Response with success status
   */
  async addMember(groupCn, memberDn) {
    if (!this.groupsEndpoint) {
      throw new Error('GroupManager not initialized. Call init() first.');
    }

    try {
      const url = this.groupsEndpoint.addMember.replace(
        ':id',
        encodeURIComponent(groupCn)
      );
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ member: memberDn }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to add member: ${response.status}`
        );
      }

      const result = await response.json();
      const memberCount = Array.isArray(memberDn) ? memberDn.length : 1;
      console.log(`Added ${memberCount} member(s) to group "${groupCn}"`);

      return result;
    } catch (error) {
      console.error(`Error adding member to group "${groupCn}":`, error);
      throw error;
    }
  }

  /**
   * Remove a member from a group
   * @param {string} groupCn - Group common name
   * @param {string} memberDn - Member DN to remove
   * @returns {Promise<Object>} Response with success status
   */
  async removeMember(groupCn, memberDn) {
    if (!this.groupsEndpoint) {
      throw new Error('GroupManager not initialized. Call init() first.');
    }

    try {
      const url = this.groupsEndpoint.removeMember
        .replace(':cn', encodeURIComponent(groupCn))
        .replace(':memberId', encodeURIComponent(memberDn));

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to remove member: ${response.status}`
        );
      }

      const result = await response.json();
      console.log(`Removed member from group "${groupCn}"`);

      return result;
    } catch (error) {
      console.error(`Error removing member from group "${groupCn}":`, error);
      throw error;
    }
  }

  /**
   * Get all members of a group
   * @param {string} cn - Group common name
   * @returns {Promise<string[]>} Array of member DNs
   */
  async getMembers(cn) {
    try {
      const group = await this.getGroup(cn);
      const members = group.member || [];

      // LDAP attributes are always arrays, ensure we return an array
      return Array.isArray(members) ? members : [members];
    } catch (error) {
      console.error(`Error getting members of group "${cn}":`, error);
      throw error;
    }
  }

  /**
   * Check if a user is a member of a group
   * @param {string} groupCn - Group common name
   * @param {string} userDn - User DN to check
   * @returns {Promise<boolean>} True if user is a member
   */
  async isMember(groupCn, userDn) {
    try {
      const members = await this.getMembers(groupCn);
      return members.includes(userDn);
    } catch (error) {
      console.error(`Error checking membership in group "${groupCn}":`, error);
      throw error;
    }
  }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GroupManager;
}
```

### Usage Example

```javascript
// Initialize the GroupManager
const manager = new GroupManager('http://localhost:8081');

async function demonstrateGroupManagement() {
  try {
    // Initialize
    console.log('Initializing GroupManager...');
    await manager.init();

    // List all groups
    console.log('\n--- Listing all groups ---');
    const allGroups = await manager.listGroups();
    console.log('All groups:', Object.keys(allGroups));

    // Create a new group
    console.log('\n--- Creating a new group ---');
    const newGroup = await manager.createGroup('developers', {
      description: 'Development Team',
      member: ['uid=alice,ou=users,dc=example,dc=com'],
    });
    console.log('Created group:', newGroup.dn);

    // Get group details
    console.log('\n--- Getting group details ---');
    const groupDetails = await manager.getGroup('developers');
    console.log('Group details:', groupDetails);

    // Add members to group
    console.log('\n--- Adding members ---');
    await manager.addMember('developers', 'uid=bob,ou=users,dc=example,dc=com');
    await manager.addMember('developers', [
      'uid=carol,ou=users,dc=example,dc=com',
      'uid=dave,ou=users,dc=example,dc=com',
    ]);

    // Get all members
    console.log('\n--- Getting all members ---');
    const members = await manager.getMembers('developers');
    console.log('Group members:', members);

    // Check membership
    console.log('\n--- Checking membership ---');
    const isBobMember = await manager.isMember(
      'developers',
      'uid=bob,ou=users,dc=example,dc=com'
    );
    console.log('Is Bob a member?', isBobMember);

    // Update group description
    console.log('\n--- Updating group ---');
    await manager.updateGroup('developers', {
      replace: {
        description: 'Software Development Team',
      },
    });

    // Remove a member
    console.log('\n--- Removing member ---');
    await manager.removeMember(
      'developers',
      'uid=dave,ou=users,dc=example,dc=com'
    );

    // List updated members
    const updatedMembers = await manager.getMembers('developers');
    console.log('Updated members:', updatedMembers);

    // Filter groups
    console.log('\n--- Filtering groups ---');
    const filteredGroups = await manager.listGroups('dev*');
    console.log('Groups matching "dev*":', Object.keys(filteredGroups));
  } catch (error) {
    console.error('Error in demonstration:', error);
  }
}

// Run the demonstration
demonstrateGroupManagement();
```

### HTML Usage Example

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Group Management - LDAP-Rest</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        max-width: 1200px;
        margin: 0 auto;
        padding: 2rem;
        background: #f5f5f5;
      }

      .container {
        background: white;
        padding: 2rem;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }

      h1 {
        margin-bottom: 2rem;
      }

      .button {
        padding: 0.5rem 1rem;
        margin: 0.25rem;
        background: #6200ee;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }

      .button:hover {
        background: #3700b3;
      }

      #output {
        margin-top: 2rem;
        padding: 1rem;
        background: #f8f9fa;
        border-radius: 4px;
        font-family: monospace;
        white-space: pre-wrap;
        max-height: 600px;
        overflow-y: auto;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Group Management</h1>

      <div>
        <button class="button" onclick="listAllGroups()">
          List All Groups
        </button>
        <button class="button" onclick="createTestGroup()">
          Create Test Group
        </button>
        <button class="button" onclick="addTestMember()">Add Member</button>
        <button class="button" onclick="removeTestMember()">
          Remove Member
        </button>
      </div>

      <div id="output">Ready. Click a button to perform an operation.</div>
    </div>

    <script src="./GroupManager.js"></script>
    <script>
      const manager = new GroupManager();
      const output = document.getElementById('output');

      // Initialize on page load
      manager
        .init()
        .then(() => {
          output.textContent =
            'GroupManager initialized successfully!\n\nClick a button to perform an operation.';
        })
        .catch(error => {
          output.textContent = 'Failed to initialize:\n' + error.message;
        });

      async function listAllGroups() {
        try {
          output.textContent = 'Loading groups...';
          const groups = await manager.listGroups();
          output.textContent = 'Groups:\n\n' + JSON.stringify(groups, null, 2);
        } catch (error) {
          output.textContent = 'Error:\n' + error.message;
        }
      }

      async function createTestGroup() {
        try {
          output.textContent = 'Creating test group...';
          const result = await manager.createGroup('test-group', {
            description: 'Test Group',
            member: ['uid=testuser,ou=users,dc=example,dc=com'],
          });
          output.textContent =
            'Group created:\n\n' + JSON.stringify(result, null, 2);
        } catch (error) {
          output.textContent = 'Error:\n' + error.message;
        }
      }

      async function addTestMember() {
        try {
          output.textContent = 'Adding member...';
          const result = await manager.addMember(
            'test-group',
            'uid=newuser,ou=users,dc=example,dc=com'
          );
          output.textContent =
            'Member added:\n\n' + JSON.stringify(result, null, 2);
        } catch (error) {
          output.textContent = 'Error:\n' + error.message;
        }
      }

      async function removeTestMember() {
        try {
          output.textContent = 'Removing member...';
          const result = await manager.removeMember(
            'test-group',
            'uid=newuser,ou=users,dc=example,dc=com'
          );
          output.textContent =
            'Member removed:\n\n' + JSON.stringify(result, null, 2);
        } catch (error) {
          output.textContent = 'Error:\n' + error.message;
        }
      }
    </script>
  </body>
</html>
```

---

## Next Steps

- **[REST API Documentation](../api/REST_API.md)** - Learn about all available API endpoints
- **[Browser Libraries Guide](../browser/LIBRARIES.md)** - Detailed documentation for LdapTreeViewer and LdapUserEditor
- **[JSON Schemas Guide](../schemas/SCHEMAS.md)** - Understanding schema-driven architecture
- **[Developer Guide](../DEVELOPER_GUIDE.md)** - Complete developer documentation

---

## Resources

- [GitHub Repository](https://github.com/linagora/ldap-rest)
- [API Reference](../api/REFERENCE.md)
- [Plugin Development](../plugins/DEVELOPMENT.md)

---

## License

AGPL-3.0 - Copyright 2025-present LINAGORA
