import { expect } from 'chai';
import request from 'supertest';
import type { Express, Request, Response } from 'express';

import { DM } from '../../../src/bin';
import DmPlugin from '../../../src/abstract/plugin';
import TrustedProxy from '../../../src/plugins/auth/trustedProxy';

// Simple plugin that exposes the X-Forwarded-For header value
class HeaderInspector extends DmPlugin {
  name = 'headerInspector';

  api(app: Express): void {
    app.get('/api/inspect', (req: Request, res: Response) => {
      res.json({
        xForwardedFor: req.headers['x-forwarded-for'] || null,
        remoteAddress: req.socket.remoteAddress,
      });
    });
  }
}

describe('TrustedProxy Plugin', () => {
  describe('Configuration - no config', () => {
    before(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should throw error if trusted_proxy is not configured', async () => {
      const dm = new DM();
      await dm.ready;

      expect(() => new TrustedProxy(dm)).to.throw(
        'TrustedProxy plugin requires trusted_proxy configuration'
      );
    });
  });

  describe('Configuration - invalid IP', () => {
    before(() => {
      process.env.DM_TRUSTED_PROXIES = 'not-an-ip';
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should throw error for invalid IP address', async () => {
      const dm = new DM();
      await dm.ready;

      expect(() => new TrustedProxy(dm)).to.throw('Invalid');
    });
  });

  describe('Configuration - invalid CIDR', () => {
    before(() => {
      process.env.DM_TRUSTED_PROXIES = '192.168.1.0/99';
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should throw error for invalid CIDR notation', async () => {
      const dm = new DM();
      await dm.ready;

      expect(() => new TrustedProxy(dm)).to.throw('Invalid prefix length');
    });
  });

  describe('Configuration - valid IPv4', () => {
    before(() => {
      process.env.DM_TRUSTED_PROXIES = '127.0.0.1,192.168.1.1';
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should accept valid IPv4 addresses', async () => {
      const dm = new DM();
      await dm.ready;

      expect(() => new TrustedProxy(dm)).to.not.throw();
    });
  });

  describe('Configuration - valid CIDR', () => {
    before(() => {
      process.env.DM_TRUSTED_PROXIES = '10.0.0.0/8,192.168.0.0/16';
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should accept valid CIDR ranges', async () => {
      const dm = new DM();
      await dm.ready;

      expect(() => new TrustedProxy(dm)).to.not.throw();
    });
  });

  describe('Configuration - valid IPv6', () => {
    before(() => {
      process.env.DM_TRUSTED_PROXIES = '::1,fe80::1';
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should accept valid IPv6 addresses', async () => {
      const dm = new DM();
      await dm.ready;

      expect(() => new TrustedProxy(dm)).to.not.throw();
    });
  });

  describe('Header Filtering - trusted proxy (localhost IPv4)', () => {
    let app: Express;

    before(async () => {
      // supertest uses 127.0.0.1 by default
      process.env.DM_TRUSTED_PROXIES = '127.0.0.1';
      const dm = new DM();
      await dm.ready;

      const trustedProxy = new TrustedProxy(dm);
      const headerInspector = new HeaderInspector(dm);

      await dm.registerPlugin('trustedProxy', trustedProxy);
      await dm.registerPlugin('headerInspector', headerInspector);

      app = dm.app;
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should preserve X-Forwarded-For from trusted proxy', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '203.0.113.50');

      expect(response.status).to.equal(200);
      expect(response.body.xForwardedFor).to.equal('203.0.113.50');
    });
  });

  describe('Header Filtering - trusted proxy (localhost IPv6)', () => {
    let app: Express;

    before(async () => {
      // Also trust ::1 for IPv6 localhost
      process.env.DM_TRUSTED_PROXIES = '127.0.0.1,::1';
      const dm = new DM();
      await dm.ready;

      const trustedProxy = new TrustedProxy(dm);
      const headerInspector = new HeaderInspector(dm);

      await dm.registerPlugin('trustedProxy', trustedProxy);
      await dm.registerPlugin('headerInspector', headerInspector);

      app = dm.app;
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should preserve X-Forwarded-For', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '203.0.113.50');

      expect(response.status).to.equal(200);
      expect(response.body.xForwardedFor).to.equal('203.0.113.50');
    });
  });

  describe('Header Filtering - untrusted source', () => {
    let app: Express;

    before(async () => {
      // Trust a different IP than localhost (supertest uses 127.0.0.1)
      process.env.DM_TRUSTED_PROXIES = '10.0.0.1';
      const dm = new DM();
      await dm.ready;

      const trustedProxy = new TrustedProxy(dm);
      const headerInspector = new HeaderInspector(dm);

      await dm.registerPlugin('trustedProxy', trustedProxy);
      await dm.registerPlugin('headerInspector', headerInspector);

      app = dm.app;
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should remove X-Forwarded-For from untrusted source', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '203.0.113.50, 192.168.1.1');

      expect(response.status).to.equal(200);
      // X-Forwarded-For should be removed since 127.0.0.1 is not trusted
      expect(response.body.xForwardedFor).to.equal(null);
    });

    it('should allow requests without X-Forwarded-For', async () => {
      const response = await request(app).get('/api/inspect');

      expect(response.status).to.equal(200);
      expect(response.body.xForwardedFor).to.equal(null);
    });
  });

  describe('Header Filtering - CIDR ranges', () => {
    let app: Express;

    before(async () => {
      // Trust entire 127.0.0.0/8 range
      process.env.DM_TRUSTED_PROXIES = '127.0.0.0/8';
      const dm = new DM();
      await dm.ready;

      const trustedProxy = new TrustedProxy(dm);
      const headerInspector = new HeaderInspector(dm);

      await dm.registerPlugin('trustedProxy', trustedProxy);
      await dm.registerPlugin('headerInspector', headerInspector);

      app = dm.app;
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should trust CIDR ranges', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '203.0.113.50');

      expect(response.status).to.equal(200);
      expect(response.body.xForwardedFor).to.equal('203.0.113.50');
    });
  });

  describe('Header Filtering - IPv4-mapped IPv6', () => {
    let app: Express;

    before(async () => {
      // Trust 127.0.0.1 - should match ::ffff:127.0.0.1
      process.env.DM_TRUSTED_PROXIES = '127.0.0.1';
      const dm = new DM();
      await dm.ready;

      const trustedProxy = new TrustedProxy(dm);
      const headerInspector = new HeaderInspector(dm);

      await dm.registerPlugin('trustedProxy', trustedProxy);
      await dm.registerPlugin('headerInspector', headerInspector);

      app = dm.app;
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should handle IPv4-mapped IPv6 addresses', async () => {
      // supertest typically connects as 127.0.0.1 or ::ffff:127.0.0.1
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '203.0.113.50');

      expect(response.status).to.equal(200);
      expect(response.body.xForwardedFor).to.equal('203.0.113.50');
    });
  });

  describe('Integration - header filtering before other plugins', () => {
    let app: Express;

    before(async () => {
      // Untrusted source - X-Forwarded-For should be stripped
      process.env.DM_TRUSTED_PROXIES = '10.0.0.1';
      const dm = new DM();
      await dm.ready;

      const trustedProxy = new TrustedProxy(dm);
      const headerInspector = new HeaderInspector(dm);

      // TrustedProxy MUST be registered before other plugins
      await dm.registerPlugin('trustedProxy', trustedProxy);
      await dm.registerPlugin('headerInspector', headerInspector);

      app = dm.app;
    });

    after(() => {
      delete process.env.DM_TRUSTED_PROXIES;
    });

    it('should filter headers before other plugins see them', async () => {
      // Attacker tries to spoof their IP
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '1.2.3.4');

      expect(response.status).to.equal(200);
      // The spoofed header should be removed
      expect(response.body.xForwardedFor).to.equal(null);
    });
  });
});
