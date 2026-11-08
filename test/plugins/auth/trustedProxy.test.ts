import { expect } from 'chai';
import request from 'supertest';
import type { Express, Request, Response } from 'express';
import DmPlugin from '@ldap-rest/core/abstract/plugin';
import TrustedProxy from '@ldap-rest/auth-trustedproxy';

import { DM } from '../../helpers/dm';

// Simple plugin that exposes the X-Forwarded-For header value and trusted proxy info
class HeaderInspector extends DmPlugin {
  name = 'headerInspector';

  api(app: Express): void {
    app.get('/api/inspect', (req: Request, res: Response) => {
      res.json({
        xForwardedFor: req.headers['x-forwarded-for'] || null,
        remoteAddress: req.socket.remoteAddress,
        trustedProxy: req.trustedProxy || false,
        proxyAuthUser: req.proxyAuthUser || null,
        clientIp: req.clientIp || null,
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
      expect(response.body.clientIp).to.equal('203.0.113.50');
    });

    it('reads the client from the right of the forwarded chain', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '1.2.3.4, 203.0.113.9');

      expect(response.status).to.equal(200);
      expect(response.body.clientIp).to.equal('203.0.113.9');
    });

    it('skips trusted proxies in the forwarded chain', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '198.51.100.7, 127.0.0.1');

      expect(response.status).to.equal(200);
      expect(response.body.clientIp).to.equal('198.51.100.7');
    });

    it('reads an address carrying a port', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '10.0.0.1, 203.0.113.9:4711');

      expect(response.status).to.equal(200);
      expect(response.body.clientIp).to.equal('203.0.113.9');
    });

    it('reads a bracketed IPv6 address carrying a port', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '10.0.0.2, [2001:db8::9]:4711');

      expect(response.status).to.equal(200);
      expect(response.body.clientIp).to.equal('2001:db8::9');
    });

    it('uses the peer when the rightmost entry is not an address', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Forwarded-For', '10.0.0.3, unknown');

      expect(response.status).to.equal(200);
      expect(response.body.clientIp).to.be.oneOf([
        '127.0.0.1',
        '::ffff:127.0.0.1',
      ]);
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
      expect(response.body.clientIp).to.be.oneOf([
        '127.0.0.1',
        '::ffff:127.0.0.1',
      ]);
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

  describe('Auth-User header from trusted proxy', () => {
    let app: Express;

    before(async () => {
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

    it('should extract Auth-User from trusted proxy', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('Auth-User', 'john.doe@example.com');

      expect(response.status).to.equal(200);
      expect(response.body.trustedProxy).to.equal(true);
      expect(response.body.proxyAuthUser).to.equal('john.doe@example.com');
    });

    it('should mark request as trusted even without Auth-User', async () => {
      const response = await request(app).get('/api/inspect');

      expect(response.status).to.equal(200);
      expect(response.body.trustedProxy).to.equal(true);
      expect(response.body.proxyAuthUser).to.equal(null);
    });
  });

  describe('Auth-User header from untrusted source', () => {
    let app: Express;

    before(async () => {
      // Trust a different IP than localhost
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

    it('should NOT extract Auth-User from untrusted source', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('Auth-User', 'attacker@evil.com');

      expect(response.status).to.equal(200);
      expect(response.body.trustedProxy).to.equal(false);
      // Auth-User should NOT be trusted from untrusted source
      expect(response.body.proxyAuthUser).to.equal(null);
    });
  });

  describe('Custom auth header', () => {
    let app: Express;

    before(async () => {
      process.env.DM_TRUSTED_PROXIES = '127.0.0.1';
      process.env.DM_TRUSTED_PROXY_AUTH_HEADER = 'X-Remote-User';
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
      delete process.env.DM_TRUSTED_PROXY_AUTH_HEADER;
    });

    it('should use custom auth header name', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('X-Remote-User', 'custom.user@example.com');

      expect(response.status).to.equal(200);
      expect(response.body.trustedProxy).to.equal(true);
      expect(response.body.proxyAuthUser).to.equal('custom.user@example.com');
    });

    it('should ignore default Auth-User header when custom is configured', async () => {
      const response = await request(app)
        .get('/api/inspect')
        .set('Auth-User', 'should.be.ignored@example.com');

      expect(response.status).to.equal(200);
      expect(response.body.trustedProxy).to.equal(true);
      // Auth-User should be ignored, X-Remote-User is not set
      expect(response.body.proxyAuthUser).to.equal(null);
    });
  });
});

describe('TrustedProxy network parsing', () => {
  type Parser = {
    logger: { error: (...args: unknown[]) => void };
    trustedNetworks: unknown[];
    parseCIDR(cidr: string): { ip: bigint; mask: bigint; isIPv6: boolean };
    isTrustedProxy(ip: string): boolean;
  };

  const parser = Object.create(TrustedProxy.prototype) as Parser;
  parser.logger = { error: (): void => undefined };

  const proxy = (networks: string[]): Parser => {
    const p = Object.create(TrustedProxy.prototype) as Parser;
    p.logger = { error: (): void => undefined };
    p.trustedNetworks = networks.map(n => p.parseCIDR(n));
    return p;
  };

  describe('malformed networks', () => {
    for (const cidr of [
      ':::',
      '::/2.',
      '10.0.0.0/2.',
      '0.5.0.1\x1b',
      '10.0.0.0/24x',
      '1abc.0.0.1',
      '10.0.0.0/+8',
      '10.0.0.0/',
      '10.0.0.0/24/25',
    ])
      it(`rejects ${JSON.stringify(cidr)}`, () => {
        expect(() => parser.parseCIDR(cidr)).to.throw(Error);
      });
  });

  describe('IPv6 with a dotted IPv4 tail', () => {
    it('reads ::10.0.0.0 as ::a00:0', () => {
      expect(parser.parseCIDR('::10.0.0.0').ip).to.equal(0x0a000000n);
    });

    it('reads 64:ff9b::10.0.0.0/120 as 64:ff9b::a00:0/120', () => {
      const { ip, mask, isIPv6 } = parser.parseCIDR('64:ff9b::10.0.0.0/120');
      expect(isIPv6).to.equal(true);
      expect(ip & mask).to.equal((0x64ff9bn << 96n) | 0x0a000000n);
    });

    it('reads a mapped network as the IPv4 network it is', () => {
      expect(parser.parseCIDR('::ffff:0.0.0.127/120')).to.deep.equal({
        ip: 0x7fn,
        mask: 0xffffff00n,
        isIPv6: false,
      });
    });
  });

  describe('IPv4-mapped spellings', () => {
    it('matches every spelling of a mapped address against an IPv4 range', () => {
      const p = proxy(['139.0.0.0/8']);
      for (const address of [
        '::ffff:139.139.0.0',
        '::ffff:8b8b:0',
        '::FFFF:8B8B:0',
        '0:0:0:0:0:ffff:8b8b:0',
      ])
        expect(p.isTrustedProxy(address), address).to.equal(true);
    });

    it('matches a mapped network against the peer Node reports', () => {
      const p = proxy(['::ffff:10.0.0.0/104']);
      expect(p.isTrustedProxy('::ffff:10.1.2.3')).to.equal(true);
      expect(p.isTrustedProxy('::ffff:11.1.2.3')).to.equal(false);
    });

    it('keeps a mapped network beyond the mapping an IPv6 network', () => {
      const parses = parser.parseCIDR('::ffff:0:0/80');
      expect(parses.isIPv6).to.equal(true);
    });
  });

  describe('zone index', () => {
    it('trusts a link-local peer with a zone index', () => {
      const p = proxy(['fe80::/10']);
      expect(p.isTrustedProxy('fe80::1%eth0')).to.equal(true);
      expect(p.isTrustedProxy('::%1')).to.equal(false);
    });

    it('refuses a configured network with a zone index', () => {
      for (const cidr of ['fe80::1%eth0', 'fe80::1%', '::%1'])
        expect(() => parser.parseCIDR(cidr), cidr).to.throw(Error);
    });
  });

  describe('valid networks kept as they are', () => {
    it('reads plain IPv4, IPv6 and prefixless networks', () => {
      expect(parser.parseCIDR('10.0.0.0/8')).to.deep.equal({
        ip: 0x0a000000n,
        mask: 0xff000000n,
        isIPv6: false,
      });
      expect(parser.parseCIDR('::1')).to.deep.equal({
        ip: 1n,
        mask: (1n << 128n) - 1n,
        isIPv6: true,
      });
      expect(parser.parseCIDR('fe80::/10').mask).to.equal(
        ((1n << 128n) - 1n) ^ ((1n << 118n) - 1n)
      );
    });
  });
});
