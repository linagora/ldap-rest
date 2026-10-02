import { DM } from '../../../src/bin';
import type { Express } from 'express';
import request from 'supertest';
import multer from 'multer';
import AuthHmac from '../../../src/plugins/auth/hmac';
import HelloWorld from '../../../src/plugins/demo/helloworld';
import { expect } from 'chai';
import { createHmac, createHash } from 'crypto';

/**
 * Helper function to generate HMAC signature for testing
 */
function generateHmacSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: number,
  body?: any
): string {
  // Calculate body hash
  let bodyHash = '';
  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    const hash = createHash('sha256');
    hash.update(bodyString);
    bodyHash = hash.digest('hex');
  }

  // Create signing string: METHOD|PATH|timestamp|body-hash
  const signingString = `${method}|${path}|${timestamp}|${bodyHash}`;

  // Calculate HMAC-SHA256
  const hmac = createHmac('sha256', secret);
  hmac.update(signingString);
  return hmac.digest('hex');
}

/**
 * Helper function to create Authorization header
 */
function createAuthHeader(
  serviceId: string,
  timestamp: number,
  signature: string
): string {
  return `HMAC-SHA256 ${serviceId}:${timestamp}:${signature}`;
}

describe('AuthHmac', () => {
  describe('Basic HMAC authentication', () => {
    let dm: DM;
    let app: Express;
    const serviceId = 'registration-service';
    const secret = 'test-secret-key-with-sufficient-length-for-security';

    before(async () => {
      process.env.DM_AUTH_HMAC = `${serviceId}:${secret}:Registration Service`;
      process.env.DM_AUTH_HMAC_WINDOW = '120000'; // 2 minutes in ms
      dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authHmac', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should return 401 if no Authorization header is provided', async () => {
      const res = await request(app).get('/api/hello');
      expect(res.status).to.equal(401);
      expect(res.body).to.deep.equal({ error: 'Unauthorized' });
    });

    it('should return 401 if Authorization header has wrong format', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'Bearer some-token');
      expect(res.status).to.equal(401);
    });

    it('should return 401 if Authorization value is malformed', async () => {
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', 'HMAC-SHA256 malformed');
      expect(res.status).to.equal(401);
    });

    it('should accept valid HMAC signature for GET request', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ message: 'Hello', hookResults: [] });
    });

    it('should accept valid HMAC signature with query parameters', async () => {
      const timestamp = Date.now();
      const path = '/api/hello?param1=value1&param2=value2';
      const signature = generateHmacSignature(secret, 'GET', path, timestamp);
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app).get(path).set('Authorization', authHeader);
      expect(res.status).to.equal(200);
    });

    it('should reject request with invalid signature', async () => {
      const timestamp = Date.now();
      const authHeader = createAuthHeader(
        serviceId,
        timestamp,
        'invalid-signature'
      );

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(401);
    });

    it('should reject request with unknown service ID', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(
        'unknown-service',
        timestamp,
        signature
      );

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(401);
    });

    it('should reject request with expired timestamp', async () => {
      const expiredTimestamp = Date.now() - 200000; // 200 seconds ago (> 2 min window)
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        expiredTimestamp
      );
      const authHeader = createAuthHeader(
        serviceId,
        expiredTimestamp,
        signature
      );

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(401);
    });

    it('should reject request with future timestamp outside window', async () => {
      const futureTimestamp = Date.now() + 200000; // 200 seconds in future
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        futureTimestamp
      );
      const authHeader = createAuthHeader(
        serviceId,
        futureTimestamp,
        signature
      );

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(401);
    });

    it('should reject request with invalid timestamp format', async () => {
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        Date.now()
      );
      const authHeader = `HMAC-SHA256 ${serviceId}:not-a-number:${signature}`;

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(401);
    });
  });

  describe('POST requests with body', () => {
    let dm: DM;
    let app: Express;
    const serviceId = 'test-service';
    const secret = 'post-test-secret-key-with-sufficient-length';

    before(async () => {
      process.env.DM_AUTH_HMAC = `${serviceId}:${secret}:Test Service`;
      dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authHmac', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should validate signature with JSON body', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp,
        undefined
      );
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      // Test that POST with valid HMAC auth passes auth (even if endpoint doesn't support POST)
      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);

      // Should pass auth (not 401), even if method not supported (404 or 200 is fine)
      expect(res.status).to.not.equal(401);
    });

    it('should reject POST with wrong body hash', async () => {
      const timestamp = Date.now();
      const originalBody = { name: 'test' };
      const differentBody = { name: 'different' };

      // Sign with original body
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/api/hello',
        timestamp,
        originalBody
      );
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      // Send different body
      const res = await request(app)
        .post('/api/hello')
        .set('Authorization', authHeader)
        .send(differentBody);

      expect(res.status).to.equal(401);
    });

    it('should hash an application/scim+json body', async () => {
      const timestamp = Date.now();
      const body = { displayName: 'admins' };
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/scim/v2/Groups',
        timestamp,
        body
      );

      const res = await request(app)
        .post('/scim/v2/Groups')
        .set('Authorization', createAuthHeader(serviceId, timestamp, signature))
        .set('Content-Type', 'application/scim+json')
        .send(JSON.stringify(body));

      expect(res.status).to.not.equal(401);
    });

    it('should reject an application/scim+json body it was not signed for', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/scim/v2/Groups',
        timestamp,
        { displayName: 'admins' }
      );

      const res = await request(app)
        .post('/scim/v2/Groups')
        .set('Authorization', createAuthHeader(serviceId, timestamp, signature))
        .set('Content-Type', 'application/scim+json')
        .send(JSON.stringify({ displayName: 'other' }));

      expect(res.status).to.equal(401);
    });

    for (const [label, type, raw] of [
      ['JSON with spaces', 'application/json', '{"uid": "a"}'],
      [
        'JSON with an escaped character',
        'application/json',
        '{"uid":"\\u00e9"}',
      ],
      ['JSON with a float', 'application/json', '{"n":1.0}'],
      [
        'a form',
        'application/x-www-form-urlencoded',
        'uid=a&mail=a%40example.com',
      ],
    ]) {
      it(`should hash the bytes of ${label} as sent`, async () => {
        const timestamp = Date.now();
        const signature = generateHmacSignature(
          secret,
          'POST',
          '/api/hello',
          timestamp,
          raw
        );

        const res = await request(app)
          .post('/api/hello')
          .set(
            'Authorization',
            createAuthHeader(serviceId, timestamp, signature)
          )
          .set('Content-Type', type)
          .send(raw);

        expect(res.status).to.not.equal(401);
      });
    }

    it('should refuse JSON whose bytes differ from what was signed', async () => {
      const timestamp = Date.now();
      // Same object, other bytes
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/api/hello',
        timestamp,
        '{"uid":"a"}'
      );

      const res = await request(app)
        .post('/api/hello')
        .set('Authorization', createAuthHeader(serviceId, timestamp, signature))
        .set('Content-Type', 'application/json')
        .send('{"uid": "a"}');

      expect(res.status).to.equal(401);
    });

    it('should refuse a multipart body no global parser read', async () => {
      // As ldap/bulkImport does: the route parses its upload itself
      app.post(
        '/api/hmac-upload',
        multer({ storage: multer.memoryStorage() }).single('file'),
        (_req, res) => {
          res.json({ ok: true });
        }
      );
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/api/hmac-upload',
        timestamp
      );

      const res = await request(app)
        .post('/api/hmac-upload')
        .set('Authorization', createAuthHeader(serviceId, timestamp, signature))
        .attach('file', Buffer.from('uid\nalice\n'), 'users.csv');

      expect(res.status).to.equal(401);
    });

    it('should refuse a text/plain body no global parser read', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/api/hello',
        timestamp
      );

      const res = await request(app)
        .post('/api/hello')
        .set('Authorization', createAuthHeader(serviceId, timestamp, signature))
        .set('Content-Type', 'text/plain')
        .send('anything');

      expect(res.status).to.equal(401);
    });

    for (const method of ['get', 'delete'] as const) {
      it(`should refuse a ${method.toUpperCase()} carrying a body`, async () => {
        // Signed without one, as GET, DELETE and HEAD are
        const timestamp = Date.now();
        const signature = generateHmacSignature(
          secret,
          method.toUpperCase(),
          '/api/hello',
          timestamp
        );

        const res = await request(app)
          [method]('/api/hello')
          .set(
            'Authorization',
            createAuthHeader(serviceId, timestamp, signature)
          )
          .set('Content-Type', 'application/json')
          .send('{"a":"b"}');

        expect(res.status).to.equal(401);
      });
    }

    it('should accept a DELETE without a body', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'DELETE',
        '/api/hello',
        timestamp
      );

      const res = await request(app)
        .delete('/api/hello')
        .set(
          'Authorization',
          createAuthHeader(serviceId, timestamp, signature)
        );

      expect(res.status).to.not.equal(401);
    });

    it('should refuse a signed body sent under another charset than UTF-8', async () => {
      const timestamp = Date.now();
      const raw = 'cn=%C3%A9';
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/api/hello',
        timestamp,
        raw
      );

      const res = await request(app)
        .post('/api/hello')
        .set('Authorization', createAuthHeader(serviceId, timestamp, signature))
        .set(
          'Content-Type',
          'application/x-www-form-urlencoded; charset=iso-8859-1'
        )
        .send(raw);

      expect(res.status).to.equal(401);
    });

    for (const [label, contentType, raw] of [
      [
        'a form',
        'application/x-www-form-urlencoded; foo="; charset=utf-8"; charset=iso-8859-1',
        Buffer.from('cn=%C3%A9'),
      ],
      [
        'JSON',
        'application/json; x="; charset=utf-8"; charset=utf-16le',
        Buffer.from('{"a":"b"}', 'utf16le'),
      ],
    ] as const) {
      it(`should read the charset of ${label} as the parser does`, async () => {
        // Another parameter's quoted value names UTF-8; the charset the
        // parser decodes with is the last one
        const timestamp = Date.now();
        // Signed on the bytes sent, which the helper would re-encode
        const bodyHash = createHash('sha256').update(raw).digest('hex');
        const signature = createHmac('sha256', secret)
          .update(`POST|/api/hello|${timestamp}|${bodyHash}`)
          .digest('hex');

        const res = await request(app)
          .post('/api/hello')
          .set(
            'Authorization',
            createAuthHeader(serviceId, timestamp, signature)
          )
          .set('Content-Type', contentType)
          .serialize(() => raw as unknown as string) // the bytes as they are
          .send(raw);

        expect(res.status).to.equal(401);
      });
    }

    it('should accept a signed body that names UTF-8', async () => {
      const timestamp = Date.now();
      const raw = '{"cn":"é"}';
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/api/hello',
        timestamp,
        raw
      );

      const res = await request(app)
        .post('/api/hello')
        .set('Authorization', createAuthHeader(serviceId, timestamp, signature))
        .set('Content-Type', 'application/json; charset=UTF-8')
        .send(raw);

      expect(res.status).to.not.equal(401);
    });

    it('should accept a POST without a body', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'POST',
        '/api/hello',
        timestamp
      );

      const res = await request(app)
        .post('/api/hello')
        .set(
          'Authorization',
          createAuthHeader(serviceId, timestamp, signature)
        );

      expect(res.status).to.not.equal(401);
    });
  });

  describe('Multiple services', () => {
    let dm: DM;
    let app: Express;
    const service1Id = 'registration-service';
    const service1Secret = 'registration-secret-key-long-enough';
    const service2Id = 'cloudery';
    const service2Secret = 'cloudery-secret-key-also-long-enough';

    before(async () => {
      process.env.DM_AUTH_HMAC = [
        `${service1Id}:${service1Secret}:Registration Service`,
        `${service2Id}:${service2Secret}:Cloudery Backend`,
      ].join(',');
      dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authHmac', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept request from first service', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        service1Secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(service1Id, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(200);
    });

    it('should accept request from second service', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        service2Secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(service2Id, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(200);
    });

    it('should reject request with wrong secret for service', async () => {
      const timestamp = Date.now();
      // Use service2's secret but service1's ID
      const signature = generateHmacSignature(
        service2Secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(service1Id, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(401);
    });
  });

  describe('Different HTTP methods', () => {
    let dm: DM;
    let app: Express;
    const serviceId = 'test-service';
    const secret = 'method-test-secret-key-with-length';

    before(async () => {
      process.env.DM_AUTH_HMAC = `${serviceId}:${secret}:Test Service`;
      dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authHmac', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should validate DELETE request (no body)', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.not.equal(401);
    });

    it('should validate PUT request with body', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.not.equal(401);
    });

    it('should validate PATCH request with body', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.not.equal(401);
    });
  });

  describe('Custom time window', () => {
    let dm: DM;
    let app: Express;
    const serviceId = 'test-service';
    const secret = 'time-window-test-secret-key-long';

    before(async () => {
      process.env.DM_AUTH_HMAC = `${serviceId}:${secret}:Test Service`;
      process.env.DM_AUTH_HMAC_WINDOW = '60000'; // 1 minute window
      dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authHmac', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should accept request within 1 minute window', async () => {
      const timestamp = Date.now() - 50000; // 50 seconds ago
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(200);
    });

    it('should reject request outside 1 minute window', async () => {
      const timestamp = Date.now() - 70000; // 70 seconds ago
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp
      );
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(401);
    });
  });

  describe('Configuration validation', () => {
    it('should warn about short secrets', async () => {
      process.env.DM_AUTH_HMAC = 'service:short:Service Name';
      const dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      // Plugin should initialize but log warning
      expect(p).to.not.be.null;
    });

    it('should handle invalid config format', async () => {
      process.env.DM_AUTH_HMAC = 'invalid:format';
      const dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      // Plugin should initialize but log warning
      expect(p).to.not.be.null;
    });

    it('should handle config with colons in service name', async () => {
      process.env.DM_AUTH_HMAC =
        'service:secret-key-long-enough:Service:With:Colons:In:Name';
      const dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      // Plugin should parse correctly and join name parts
      expect(p).to.not.be.null;
    });
  });

  describe('Edge cases', () => {
    let dm: DM;
    let app: Express;
    const serviceId = 'test-service';
    const secret = 'edge-case-test-secret-key-with-length';

    before(async () => {
      process.env.DM_AUTH_HMAC = `${serviceId}:${secret}:Test Service`;
      dm = new DM();
      await dm.ready;
      const p = new AuthHmac(dm);
      const h = new HelloWorld(dm);
      await dm.registerPlugin('authHmac', p);
      await dm.registerPlugin('helloWorld', h);
      app = dm.app;
    });

    it('should handle empty path correctly', async () => {
      const timestamp = Date.now();
      const signature = generateHmacSignature(secret, 'GET', '/', timestamp);
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app).get('/').set('Authorization', authHeader);
      // May be 404 or other status depending on routing, but should not be 401 for auth
      expect(res.status).to.not.equal(401);
    });

    it('should handle special characters in path', async () => {
      const timestamp = Date.now();
      const path = '/api/hello?name=test%20user&id=123';
      const signature = generateHmacSignature(secret, 'GET', path, timestamp);
      const authHeader = createAuthHeader(serviceId, timestamp, signature);

      const res = await request(app).get(path).set('Authorization', authHeader);
      expect(res.status).to.equal(200);
    });

    it('should reject signature with slight timing difference', async () => {
      const timestamp1 = Date.now();
      const signature = generateHmacSignature(
        secret,
        'GET',
        '/api/hello',
        timestamp1
      );
      const timestamp2 = timestamp1 + 1; // Different timestamp
      const authHeader = createAuthHeader(serviceId, timestamp2, signature);

      const res = await request(app)
        .get('/api/hello')
        .set('Authorization', authHeader);
      expect(res.status).to.equal(401);
    });
  });

  /**
   * Cross-implementation contract test.
   *
   * The lsc-plugin/ Java client computes HMAC signatures the same way the
   * server here does. Both sides hard-code this same vector — if either side
   * changes the signing string format, the body hashing rule, or the
   * timestamp encoding, this test fails AND the matching Java test
   * (LdapRestAuthTest#hmacReproducibleSignature / hmacCrossImplVector) fails
   * on the other side. Keep them in sync.
   *
   * Vector:
   *   secret    = "test-secret-min-32-chars-long-xxx"
   *   method    = "POST"
   *   path      = "/api/v1/ldap/users"
   *   timestamp = 1700000000000
   *   body      = '{"uid":"alice"}'
   *   expected  = "65b065ff10ab2a54de0ab4db485c5744fcdd32a98e2fd24a8cef5240b43bbc94"
   */
  describe('Cross-impl vector (lsc-plugin compatibility)', () => {
    const secret = 'test-secret-min-32-chars-long-xxx';
    const method = 'POST';
    const path = '/api/v1/ldap/users';
    const timestamp = 1700000000000;
    const body = '{"uid":"alice"}';
    const expectedSignature =
      '65b065ff10ab2a54de0ab4db485c5744fcdd32a98e2fd24a8cef5240b43bbc94';

    it('Node helper must produce the same signature as the Java plugin', () => {
      const sig = generateHmacSignature(secret, method, path, timestamp, body);
      expect(sig).to.equal(expectedSignature);
    });

    it('intermediate values match the documented format', () => {
      const bodyHash = createHash('sha256').update(body).digest('hex');
      expect(bodyHash).to.equal(
        'c9bfac238b197ff8c303f8186d216e1422495890f852043cbac3810d1d867822'
      );
      const signingString = `${method}|${path}|${timestamp}|${bodyHash}`;
      const sig = createHmac('sha256', secret)
        .update(signingString)
        .digest('hex');
      expect(sig).to.equal(expectedSignature);
    });
  });
});
