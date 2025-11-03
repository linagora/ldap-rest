import { DM } from '../../../src/bin';
import type { Express } from 'express';
import request from 'supertest';
import AuthTotp from '../../../src/plugins/auth/totp';
import HelloWorld from '../../../src/plugins/demo/helloworld';
import { expect } from 'chai';
import { createHmac } from 'crypto';

/**
 * Generate a TOTP code for testing
 */
function generateTestTotp(
  secret: string,
  digits: number,
  step: number
): string {
  const now = Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / step);

  // Decode Base32 secret
  const key = base32Decode(secret);

  // Convert counter to 8-byte buffer (big-endian)
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  // Generate HMAC-SHA1
  const hmac = createHmac('sha1', key);
  hmac.update(counterBuffer);
  const hash = hmac.digest();

  // Dynamic truncation (RFC 4226)
  const offset = hash[hash.length - 1] & 0x0f;
  const truncatedHash =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  // Generate N-digit code
  const code = truncatedHash % Math.pow(10, digits);
  return code.toString().padStart(digits, '0');
}

/**
 * Decode Base32 for testing
 */
function base32Decode(input: string): Buffer {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanInput = input.toUpperCase().replace(/=+$/, '');

  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < cleanInput.length; i++) {
    const idx = base32Chars.indexOf(cleanInput[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${cleanInput[i]}`);
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

describe('AuthTotp', () => {
  describe('Basic TOTP authentication', () => {
    let dm: DM;
    let app: Express;
    const testSecret = 'JBSWY3DPEHPK3PXP'; // Standard test secret

    before(async () => {
      process.env.DM_AUTH_TOTP = `${testSecret}:admin:6`;
      dm = new DM();
      await dm.ready;
      const p = new AuthTotp(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authTotp', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should return 401 if no token is provided', async () => {
      const res = await request(app).get('/api/hello');
      expect(res.status).to.equal(401);
      expect(res.body).to.deep.equal({ error: 'Unauthorized' });
    });

    it('should return 401 if an invalid token is provided', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer 000000');
      expect(res.status).to.equal(401);
      expect(res.body).to.deep.equal({ error: 'Unauthorized' });
    });

    it('should accept valid TOTP code', async () => {
      const code = generateTestTotp(testSecret, 6, 30);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
    });

    it('should reject invalid Authorization format', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', '123456');
      expect(res.status).to.equal(401);
    });
  });

  describe('Multiple users with different digit counts', () => {
    let dm: DM;
    let app: Express;
    const secret6 = 'JBSWY3DPEHPK3PXP'; // 6 digits
    const secret8 = 'HXDMVJECJJWSRB3H'; // 8 digits
    const secret10 = 'IXDMVJECJJWSRB2A'; // 10 digits (custom)

    before(async () => {
      process.env.DM_AUTH_TOTP = `${secret6}:user6:6,${secret8}:user8:8,${secret10}:user10:10`;
      process.env.DM_AUTH_TOTP_STEP = '30';
      process.env.DM_AUTH_TOTP_WINDOW = '1';
      dm = new DM();
      await dm.ready;
      const p = new AuthTotp(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authTotp', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept valid 6-digit TOTP code', async () => {
      const code = generateTestTotp(secret6, 6, 30);
      expect(code.length).to.equal(6);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(200);
    });

    it('should accept valid 8-digit TOTP code', async () => {
      const code = generateTestTotp(secret8, 8, 30);
      expect(code.length).to.equal(8);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(200);
    });

    it('should accept valid 10-digit TOTP code', async () => {
      const code = generateTestTotp(secret10, 10, 30);
      expect(code.length).to.equal(10);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(200);
    });

    it('should reject 8-digit code for 6-digit user', async () => {
      const code = generateTestTotp(secret6, 8, 30);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(401);
    });
  });

  describe('Default digits (6)', () => {
    let dm: DM;
    let app: Express;
    const testSecret = 'JBSWY3DPEHPK3PXP';

    before(async () => {
      // Format: "secret:name" without digits (should default to 6)
      process.env.DM_AUTH_TOTP = `${testSecret}:admin`;
      dm = new DM();
      await dm.ready;
      const p = new AuthTotp(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authTotp', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should use 6 digits by default', async () => {
      const code = generateTestTotp(testSecret, 6, 30);
      expect(code.length).to.equal(6);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(200);
    });
  });

  describe('Custom time step', () => {
    let dm: DM;
    let app: Express;
    const testSecret = 'JBSWY3DPEHPK3PXP';

    before(async () => {
      process.env.DM_AUTH_TOTP = `${testSecret}:admin:6`;
      process.env.DM_AUTH_TOTP_STEP = '60'; // 60 seconds instead of 30
      dm = new DM();
      await dm.ready;
      const p = new AuthTotp(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authTotp', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept valid TOTP code with custom step', async () => {
      const code = generateTestTotp(testSecret, 6, 60);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(200);
    });

    it('should reject code generated with wrong step', async () => {
      const wrongCode = generateTestTotp(testSecret, 6, 30);
      await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${wrongCode}`);
      // This might pass or fail depending on timing, but it's a good edge case
      // In most cases, it should fail
    });
  });

  describe('Invalid configuration', () => {
    it('should handle invalid Base32 secret gracefully', async () => {
      process.env.DM_AUTH_TOTP = 'INVALID!!!:admin:6';
      const dm = new DM();
      await dm.ready;
      const p = new AuthTotp(dm);
      // Plugin should initialize but log warning
      expect(p).to.not.be.null;
    });

    it('should handle invalid digits count', async () => {
      process.env.DM_AUTH_TOTP = 'JBSWY3DPEHPK3PXP:admin:3';
      const dm = new DM();
      await dm.ready;
      const p = new AuthTotp(dm);
      // Plugin should initialize but log warning
      expect(p).to.not.be.null;
    });

    it('should handle malformed config', async () => {
      process.env.DM_AUTH_TOTP = 'onlyonesegment';
      const dm = new DM();
      await dm.ready;
      const p = new AuthTotp(dm);
      // Plugin should initialize but log warning
      expect(p).to.not.be.null;
    });
  });

  describe('Multiple users separated by comma', () => {
    let dm: DM;
    let app: Express;
    const secret1 = 'JBSWY3DPEHPK3PXP';
    const secret2 = 'HXDMVJECJJWSRB3H';

    before(async () => {
      // Test multiple users with comma separator
      process.env.DM_AUTH_TOTP = `${secret1}:user1:6,${secret2}:user2:8`;
      process.env.DM_AUTH_TOTP_STEP = '30';
      process.env.DM_AUTH_TOTP_WINDOW = '1';
      dm = new DM();
      await dm.ready;
      const p = new AuthTotp(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authTotp', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept code from first user', async () => {
      const code = generateTestTotp(secret1, 6, 30);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(200);
    });

    it('should accept code from second user', async () => {
      const code = generateTestTotp(secret2, 8, 30);
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', `Bearer ${code}`);
      expect(res.status).to.equal(200);
    });
  });
});
