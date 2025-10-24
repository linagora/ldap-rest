/**
 * Test helper to start/stop an embedded OpenLDAP server in Docker
 * @module test/helpers/ldapServer
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface LdapServerConfig {
  /** LDAP base DN */
  baseDn: string;
  /** Admin DN */
  adminDn: string;
  /** Admin password */
  adminPassword: string;
  /** LDAP port (default: random) */
  port?: number;
  /** Docker container name */
  containerName?: string;
  /** Initial LDIF file to load */
  ldifFile?: string;
  /** Organization name */
  organization?: string;
  /** Domain components (e.g., ['example', 'com']) */
  domainComponents?: string[];
}

export class LdapTestServer {
  private containerName: string;
  private config: Required<LdapServerConfig>;
  private containerProcess?: ChildProcess;
  public port: number;

  constructor(config: LdapServerConfig) {
    this.containerName = config.containerName || `ldap-test-${Date.now()}`;
    this.port = config.port || this.getRandomPort();

    // Set defaults
    this.config = {
      baseDn: config.baseDn,
      adminDn: config.adminDn,
      adminPassword: config.adminPassword,
      port: this.port,
      containerName: this.containerName,
      ldifFile: config.ldifFile || '',
      organization: config.organization || 'Test Organization',
      domainComponents: config.domainComponents || ['example', 'com'],
    };
  }

  /**
   * Get a random available port
   */
  private getRandomPort(): number {
    // Use a port in the ephemeral range
    return 30000 + Math.floor(Math.random() * 10000);
  }

  /**
   * Start the LDAP server
   */
  async start(): Promise<void> {
    console.log(`Starting LDAP test server on port ${this.port}...`);

    // Check if Docker is available
    try {
      execSync('docker --version', { stdio: 'ignore' });
    } catch (err) {
      throw new Error(
        'Docker is not available. Please install Docker to run LDAP tests.'
      );
    }

    // Stop any existing container with the same name
    try {
      execSync(`docker rm -f ${this.containerName}`, { stdio: 'ignore' });
    } catch (err) {
      // Container doesn't exist, that's fine
    }

    // Build environment variables
    const env = [
      `-e LDAP_ORGANISATION="${this.config.organization}"`,
      `-e LDAP_DOMAIN="${this.config.domainComponents.join('.')}"`,
      `-e LDAP_ADMIN_PASSWORD="${this.config.adminPassword}"`,
      `-e LDAP_CONFIG_PASSWORD="${this.config.adminPassword}"`,
      `-e LDAP_READONLY_USER=false`,
      `-e LDAP_RFC2307BIS_SCHEMA=true`,
      `-e LDAP_BACKEND=mdb`,
      `-e LDAP_TLS=false`,
      `-e LDAP_REMOVE_CONFIG_AFTER_SETUP=true`,
    ].join(' ');

    // Start container (without volume mount to avoid permission issues)
    const cmd = `docker run -d --name ${this.containerName} \
      -p ${this.port}:389 \
      ${env} \
      osixia/openldap:1.5.0`;

    try {
      execSync(cmd, { stdio: 'pipe' });
    } catch (err) {
      throw new Error(
        `Failed to start LDAP container: ${(err as Error).message}`
      );
    }

    // Wait for LDAP to be ready
    await this.waitForReady();

    console.log(
      `✓ LDAP test server started on port ${this.port} (container: ${this.containerName})`
    );

    // Load mail schema first (contains mailAlternateAddress, mailForwardingAddress, etc.)
    const mailSchemaPath = join(__dirname, '../fixtures/mail-schema.ldif');
    if (existsSync(mailSchemaPath)) {
      console.log(`Loading mail schema from ${mailSchemaPath}...`);
      try {
        execSync(`docker cp ${mailSchemaPath} ${this.containerName}:/tmp/mail-schema.ldif`);
        const result = execSync(
          `docker exec ${this.containerName} ldapadd -Y EXTERNAL -H ldapi:/// -f /tmp/mail-schema.ldif`,
          { encoding: 'utf-8' }
        );
        console.log(`✓ Mail schema loaded`);
        if (result && result.trim()) {
          console.log(`Mail schema output: ${result.trim()}`);
        }
      } catch (err: any) {
        console.error(`ERROR loading mail schema:`);
        console.error(`  stdout: ${err.stdout?.toString()}`);
        console.error(`  stderr: ${err.stderr?.toString()}`);
        console.error(`  message: ${err.message}`);
        throw new Error(`Failed to load mail schema: ${err.stderr?.toString() || err.message}`);
      }
    }

    // Load Twake custom schema
    // Try to use the official schema from the container first
    try {
      console.log(`Attempting to load official Twake schema...`);
      const result = execSync(
        `docker exec ${this.containerName} sh -c "if [ -f /usr/local/openldap/etc/openldap/schema/twake.ldif ]; then ldapadd -Y EXTERNAL -H ldapi:/// -f /usr/local/openldap/etc/openldap/schema/twake.ldif; else exit 1; fi"`,
        { encoding: 'utf-8' }
      );
      console.log(`✓ Official Twake schema loaded from container`);
      if (result && result.trim()) {
        console.log(`Schema load output: ${result.trim()}`);
      }
    } catch (err: any) {
      // Fallback to custom schema if official one doesn't exist
      const schemaPath = join(__dirname, '../fixtures/twake-schema.ldif');
      if (existsSync(schemaPath)) {
        console.log(`Loading custom Twake schema from ${schemaPath}...`);
        try {
          // Copy schema to container
          execSync(`docker cp ${schemaPath} ${this.containerName}:/tmp/twake-schema.ldif`);

          // Load schema using ldapadd
          const result = execSync(
            `docker exec ${this.containerName} ldapadd -Y EXTERNAL -H ldapi:/// -f /tmp/twake-schema.ldif`,
            { encoding: 'utf-8' }
          );
          console.log(`✓ Custom Twake schema loaded`);
          if (result && result.trim()) {
            console.log(`Schema load output: ${result.trim()}`);
          }
        } catch (err: any) {
          console.error(`ERROR loading Twake schema:`);
          console.error(`  stdout: ${err.stdout?.toString()}`);
          console.error(`  stderr: ${err.stderr?.toString()}`);
          console.error(`  message: ${err.message}`);
          throw new Error(`Failed to load Twake schema: ${err.stderr?.toString() || err.message}`);
        }
      }
    }

    // Load initial LDIF file if provided
    if (this.config.ldifFile && existsSync(this.config.ldifFile)) {
      console.log(`Loading initial LDIF from ${this.config.ldifFile}...`);
      const ldifContent = readFileSync(this.config.ldifFile, 'utf-8');
      await this.loadLdif(ldifContent);
      console.log(`✓ Initial LDIF loaded`);
    }
  }

  /**
   * Wait for LDAP to accept connections
   */
  private async waitForReady(maxRetries = 30): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        // Try to connect with ldapsearch
        execSync(
          `docker exec ${this.containerName} ldapsearch -x -H ldap://localhost -b "${this.config.baseDn}" -D "${this.config.adminDn}" -w "${this.config.adminPassword}" -LLL "(objectClass=*)" dn`,
          { stdio: 'ignore', timeout: 2000 }
        );
        return; // Success
      } catch (err) {
        // Not ready yet, wait
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error(
      `LDAP server did not become ready after ${maxRetries} attempts`
    );
  }

  /**
   * Stop the LDAP server
   */
  async stop(): Promise<void> {
    if (!this.containerName) return;

    console.log(`Stopping LDAP test server (${this.containerName})...`);

    try {
      execSync(`docker rm -f ${this.containerName}`, { stdio: 'ignore' });
      console.log(`✓ LDAP test server stopped`);
    } catch (err) {
      console.warn(`Warning: Failed to stop LDAP container: ${err}`);
    }
  }

  /**
   * Load LDIF data into the server
   */
  async loadLdif(ldifContent: string): Promise<void> {
    // Write LDIF to temporary file in container
    const tempFile = `/tmp/load-${Date.now()}.ldif`;

    try {
      // Write LDIF content to container
      const proc = spawn('docker', [
        'exec',
        '-i',
        this.containerName,
        'bash',
        '-c',
        `cat > ${tempFile}`,
      ]);

      proc.stdin.write(ldifContent);
      proc.stdin.end();

      await new Promise((resolve, reject) => {
        proc.on('exit', code => {
          if (code === 0) resolve(undefined);
          else reject(new Error(`Failed to write LDIF to container`));
        });
      });

      // Load LDIF using ldapadd
      execSync(
        `docker exec ${this.containerName} ldapadd -x -D "${this.config.adminDn}" -w "${this.config.adminPassword}" -f ${tempFile}`,
        { stdio: 'pipe' }
      );

      // Clean up temp file
      execSync(`docker exec ${this.containerName} rm ${tempFile}`, {
        stdio: 'ignore',
      });
    } catch (err) {
      throw new Error(`Failed to load LDIF: ${(err as Error).message}`);
    }
  }

  /**
   * Execute an LDAP search command
   */
  async search(filter: string, attrs?: string[]): Promise<string> {
    const attrsStr = attrs ? attrs.join(' ') : '*';
    const cmd = `docker exec ${this.containerName} ldapsearch -x -H ldap://localhost -b "${this.config.baseDn}" -D "${this.config.adminDn}" -w "${this.config.adminPassword}" -LLL "${filter}" ${attrsStr}`;

    try {
      return execSync(cmd, { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`LDAP search failed: ${(err as Error).message}`);
    }
  }

  /**
   * Get connection configuration for tests
   */
  getConfig(): {
    url: string;
    bindDN: string;
    bindPassword: string;
    baseDN: string;
  } {
    return {
      url: `ldap://localhost:${this.port}`,
      bindDN: this.config.adminDn,
      bindPassword: this.config.adminPassword,
      baseDN: this.config.baseDn,
    };
  }

  /**
   * Get environment variables for DM server
   */
  getEnvVars(): Record<string, string> {
    return {
      // DM uses these env vars (with DM_ prefix)
      DM_LDAP_URL: `ldap://localhost:${this.port}`,
      DM_LDAP_DN: this.config.adminDn,
      DM_LDAP_PWD: this.config.adminPassword,
      DM_LDAP_BASE: this.config.baseDn,
      DM_LDAP_GROUP_BASE: `ou=groups,${this.config.baseDn}`,
      // Keep legacy names for hasExternalLdap() check
      DM_LDAP_URI: `ldap://localhost:${this.port}`,
    };
  }
}

/**
 * Create a test LDAP server with standard configuration
 */
export async function createTestLdapServer(
  ldifFile?: string
): Promise<LdapTestServer> {
  const server = new LdapTestServer({
    baseDn: 'dc=example,dc=com',
    adminDn: 'cn=admin,dc=example,dc=com',
    adminPassword: 'adminpassword',
    organization: 'Example Inc',
    domainComponents: ['example', 'com'],
    ldifFile,
  });

  await server.start();
  return server;
}

/**
 * Singleton test server for reuse across test suites
 */
let globalTestServer: LdapTestServer | null = null;

/**
 * Get or create a global test LDAP server
 * Reuses the same server across test suites for performance
 */
export async function getGlobalTestLdapServer(): Promise<LdapTestServer> {
  if (!globalTestServer) {
    globalTestServer = await createTestLdapServer(
      join(__dirname, '../fixtures/base-structure.ldif')
    );
  }
  return globalTestServer;
}

/**
 * Stop the global test LDAP server
 * Call this in global test teardown
 */
export async function stopGlobalTestLdapServer(): Promise<void> {
  if (globalTestServer) {
    await globalTestServer.stop();
    globalTestServer = null;
  }
}
