#!/usr/bin/env node

import { DM } from '../dist/bin/index.js';

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
ldap-rest - Lightweight LDAP directory manager

Usage:
  ldap-rest [OPTIONS]

Description:
  Starts the ldap-rest server which provides a REST API and web interface
  for managing LDAP directories. Configuration is done through environment
  variables or command-line arguments.

Main options:
  --help, -h                Show this help message
  --port PORT               Server port (default: 8080)
  --ldap-url URL            LDAP server URL
  --ldap-dn DN              LDAP bind DN
  --ldap-pwd PASSWORD       LDAP bind password
  --ldap-base BASE          LDAP base DN
  --plugin PLUGIN           Load plugin (can be specified multiple times)
  --api-prefix PREFIX       API prefix (default: /api)
  --log-level LEVEL         Log level (error, warn, info, debug)

See plugin documentation for additional options.

Environment Variables:
  All command-line options can also be set via environment variables
  by prefixing with DM_ and using uppercase with underscores.
  Example: --ldap-url becomes DM_LDAP_URL

Examples:
  # Start server with default configuration
  npx ldap-rest

  # Start with specific LDAP server
  npx ldap-rest --ldap-url ldap://localhost:389

  # Load specific plugins
  npx ldap-rest --plugin ldapGroups --plugin ldapOrganization
`);
  process.exit(0);
}

const server = new DM();

await server.ready;
await server.run();
