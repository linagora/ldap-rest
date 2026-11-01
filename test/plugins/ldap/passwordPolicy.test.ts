import { expect } from 'chai';
import supertest from 'supertest';
import { DM } from '../../../src/bin';
import PasswordPolicy from '../../../src/plugins/ldap/passwordPolicy';
import { skipIfMissingEnvVars, LDAP_ENV_VARS } from '../../helpers/env';

describe('PasswordPolicy Plugin', () => {
  let dm: DM;

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  beforeEach(async () => {
    dm = new DM();
    await dm.ready;
  });

  afterEach(async () => {
    if (dm) {
      await dm.stop();
    }
  });

  describe('API Endpoints', () => {
    it('should expose GET /password-policy endpoint', async () => {
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .get('/api/v1/password-policy')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body).to.be.an('object');
      // Policy may be empty if ppolicy overlay not configured
    });

    it('should return 404 for non-existent user password status', async () => {
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .get('/api/v1/users/nonexistent-user-12345/password-status')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(404);
    });

    it('should expose GET /password-policy/expiring-soon endpoint', async () => {
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .get('/api/v1/password-policy/expiring-soon')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('warningDays');
      expect(response.body).to.have.property('users');
      expect(response.body.users).to.be.an('array');
    });

    it('should accept days parameter for expiring-soon', async () => {
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .get('/api/v1/password-policy/expiring-soon?days=7')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body.warningDays).to.equal(7);
    });

    it('should refuse a days parameter that is not a number', async () => {
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const response = await supertest(dm.app).get(
        '/api/v1/password-policy/expiring-soon?days=soon'
      );
      expect(response.status).to.equal(400);
      expect(response.body.error).to.equal(
        'Invalid request: query.days: Expected integer'
      );
    });

    it('should refuse a days parameter below one', async () => {
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const response = await supertest(dm.app).get(
        '/api/v1/password-policy/expiring-soon?days=0'
      );
      expect(response.status).to.equal(400);
      expect(response.body.error).to.equal(
        'Invalid request: query.days: Expected integer to be greater or equal to 1'
      );
    });

    it('should expose GET /password-policy/locked-accounts endpoint', async () => {
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .get('/api/v1/password-policy/locked-accounts')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('accounts');
      expect(response.body.accounts).to.be.an('array');
    });
  });

  describe('Password Validation (when enabled)', () => {
    it('should expose POST /password/validate when ppolicy_validate_complexity is true', async () => {
      dm.config.ppolicy_validate_complexity = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .post('/api/v1/password/validate')
        .send({ password: 'Test123!@#Strong' })
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('valid');
      expect(response.body).to.have.property('errors');
    });

    it('should answer 400 to a body that is not JSON', async () => {
      dm.config.ppolicy_validate_complexity = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const response = await supertest(dm.app)
        .post('/api/v1/password/validate')
        .timeout(2000)
        .type('text/plain')
        .send('Test123!@#Strong');

      expect(response.status).to.equal(400);
    });

    it('should refuse a password that is not text', async () => {
      dm.config.ppolicy_validate_complexity = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const response = await supertest(dm.app)
        .post('/api/v1/password/validate')
        .send({ password: 5 })
        .set('Content-Type', 'application/json');
      expect(response.status).to.equal(400);
      expect(response.body.error).to.equal(
        'Invalid request: body.password: Expected string'
      );
    });

    it('should reject password too short', async () => {
      dm.config.ppolicy_validate_complexity = true;
      dm.config.ppolicy_min_length = 12;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .post('/api/v1/password/validate')
        .send({ password: 'Short1!' })
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body.valid).to.be.false;
      expect(response.body.errors).to.include('Minimum 12 characters required');
    });

    it('should reject password without uppercase', async () => {
      dm.config.ppolicy_validate_complexity = true;
      dm.config.ppolicy_require_uppercase = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .post('/api/v1/password/validate')
        .send({ password: 'lowercaseonly123!' })
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body.valid).to.be.false;
      expect(response.body.errors).to.include(
        'At least one uppercase letter required'
      );
    });

    it('should reject password without lowercase', async () => {
      dm.config.ppolicy_validate_complexity = true;
      dm.config.ppolicy_require_lowercase = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .post('/api/v1/password/validate')
        .send({ password: 'UPPERCASEONLY123!' })
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body.valid).to.be.false;
      expect(response.body.errors).to.include(
        'At least one lowercase letter required'
      );
    });

    it('should reject password without digit', async () => {
      dm.config.ppolicy_validate_complexity = true;
      dm.config.ppolicy_require_digit = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .post('/api/v1/password/validate')
        .send({ password: 'NoDigitsHere!@#' })
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body.valid).to.be.false;
      expect(response.body.errors).to.include('At least one digit required');
    });

    it('should reject password without special character', async () => {
      dm.config.ppolicy_validate_complexity = true;
      dm.config.ppolicy_require_special = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .post('/api/v1/password/validate')
        .send({ password: 'NoSpecialChars123' })
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body.valid).to.be.false;
      expect(response.body.errors).to.include(
        'At least one special character required'
      );
    });

    it('should accept valid password', async () => {
      dm.config.ppolicy_validate_complexity = true;
      dm.config.ppolicy_min_length = 12;
      dm.config.ppolicy_require_uppercase = true;
      dm.config.ppolicy_require_lowercase = true;
      dm.config.ppolicy_require_digit = true;
      dm.config.ppolicy_require_special = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .post('/api/v1/password/validate')
        .send({ password: 'ValidP@ssw0rd123!' })
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(200);
      expect(response.body.valid).to.be.true;
      expect(response.body.errors).to.be.empty;
    });

    it('should return 400 when password is missing', async () => {
      dm.config.ppolicy_validate_complexity = true;
      const plugin = new PasswordPolicy(dm);
      dm.registerPlugin('passwordPolicy', plugin);

      const request = supertest(dm.app);
      const response = await request
        .post('/api/v1/password/validate')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json');

      expect(response.status).to.equal(400);
    });
  });

  describe('Config API Data', () => {
    it('should provide config API data', () => {
      const plugin = new PasswordPolicy(dm);
      const configData = plugin.getConfigApiData();

      expect(configData).to.exist;
      expect(configData).to.have.property('name', 'ldapPasswordPolicy');
      expect(configData).to.have.property('enabled', true);
      expect(configData).to.have.property('endpoints');
      expect(configData).to.have.property('config');
    });

    it('should include validatePassword endpoint when enabled', () => {
      dm.config.ppolicy_validate_complexity = true;
      const plugin = new PasswordPolicy(dm);
      const configData = plugin.getConfigApiData() as Record<string, unknown>;
      const endpoints = configData?.endpoints as Record<string, unknown>;

      expect(endpoints).to.have.property('validatePassword');
      expect(endpoints?.validatePassword).to.not.be.undefined;
    });

    it('should not include validatePassword endpoint when disabled', () => {
      dm.config.ppolicy_validate_complexity = false;
      const plugin = new PasswordPolicy(dm);
      const configData = plugin.getConfigApiData() as Record<string, unknown>;
      const endpoints = configData?.endpoints as Record<string, unknown>;

      expect(endpoints?.validatePassword).to.be.undefined;
    });

    it('should include complexityRules when validation enabled', () => {
      dm.config.ppolicy_validate_complexity = true;
      dm.config.ppolicy_min_length = 16;
      dm.config.ppolicy_require_uppercase = true;
      dm.config.ppolicy_require_lowercase = false;
      const plugin = new PasswordPolicy(dm);
      const configData = plugin.getConfigApiData() as Record<string, unknown>;
      const config = configData?.config as Record<string, unknown>;
      const rules = config?.complexityRules as Record<string, unknown>;

      expect(rules).to.exist;
      expect(rules.minLength).to.equal(16);
      expect(rules.requireUppercase).to.be.true;
      expect(rules.requireLowercase).to.be.false;
    });

    it('should not include complexityRules when validation disabled', () => {
      dm.config.ppolicy_validate_complexity = false;
      const plugin = new PasswordPolicy(dm);
      const configData = plugin.getConfigApiData() as Record<string, unknown>;
      const config = configData?.config as Record<string, unknown>;

      expect(config?.complexityRules).to.be.undefined;
    });
  });
});

describe('PasswordPolicy Plugin: policy management', () => {
  let dm: DM;
  let request: ReturnType<typeof supertest>;
  let policyBase: string;
  let userDn: string;
  const api = '/api/v1/password-policies';

  before(function () {
    skipIfMissingEnvVars(this, [...LDAP_ENV_VARS]);
  });

  before(async () => {
    const base = process.env.DM_LDAP_BASE as string;
    policyBase = `ou=ppolicyMgmt,${base}`;
    userDn = `uid=ppolicy.mgmt,ou=users,${base}`;
    dm = new DM();
    await dm.ready;
    await dm.ldap.delete(userDn).catch(() => undefined);
    await dm.ldap.add(policyBase, {
      objectClass: ['top', 'organizationalUnit'],
      ou: 'ppolicyMgmt',
    });
    await dm.ldap.add(`cn=default,${policyBase}`, {
      objectClass: ['top', 'person', 'pwdPolicy'],
      cn: 'default',
      sn: 'default',
      pwdAttribute: 'userPassword',
      pwdMaxAge: '31536000',
    });
    dm.config.ppolicy_base = policyBase;
    dm.config.ldap_users_base = `ou=users,${base}`;
    dm.config.ppolicy_default_dn = `cn=default,${policyBase}`;
    await dm.registerPlugin('passwordPolicy', new PasswordPolicy(dm));
    dm.setupErrorMiddleware();
    request = supertest(dm.app);
  });

  after(async () => {
    if (!dm) return;
    await dm.ldap.delete(userDn).catch(() => undefined);
    for (const cn of ['default', 'aged', 'software', 'checked'])
      await dm.ldap.delete(`cn=${cn},${policyBase}`).catch(() => undefined);
    await dm.ldap.delete(policyBase).catch(() => undefined);
    await dm.stop();
  });

  it('creates a policy with typed values', async () => {
    const res = await request
      .post(api)
      .send({ cn: 'aged', pwdMaxAge: 864000, pwdLockout: true });
    expect(res.status).to.equal(201);
    expect(res.body).to.deep.include({
      dn: `cn=aged,${policyBase}`,
      cn: 'aged',
      isDefault: false,
      pwdAttribute: 'userPassword',
      pwdMaxAge: 864000,
      pwdLockout: true,
    });
    const created = await request.post(api).send({ cn: 'software' });
    expect(created.status).to.equal(201);
  });

  it('refuses a second policy of the same name', async () => {
    const res = await request.post(api).send({ cn: 'aged' });
    expect(res.status).to.equal(409);
  });

  it('refuses unknown, read-only and wrongly typed attributes', async () => {
    for (const body of [
      { cn: 'bad', description: 'x' },
      { cn: 'bad', pwdCheckModule: '/tmp/evil.so' },
      { cn: 'bad', pwdMaxAge: '10' },
      { cn: 'bad', pwdMaxAge: -1 },
      { cn: 'bad', pwdLockout: 'TRUE' },
      { cn: 'bad', pwdCheckQuality: 3 },
      { pwdMaxAge: 10 },
    ]) {
      const res = await request.post(api).send(body);
      expect(res.status, JSON.stringify(body)).to.equal(400);
    }
    expect((await request.get(`${api}/bad`)).status).to.equal(404);
  });

  it('lists the policies, marking the default one', async () => {
    const res = await request.get(api);
    expect(res.status).to.equal(200);
    const names = (res.body.policies as { cn: string }[]).map(p => p.cn);
    expect(names).to.deep.equal(['aged', 'default', 'software']);
    const flags = (res.body.policies as { isDefault: boolean }[]).map(
      p => p.isDefault
    );
    expect(flags).to.deep.equal([false, true, false]);
  });

  it('lists the attributes a policy can be given, as the schema defines them', async () => {
    // pwdMaxLength appeared in OpenLDAP 2.5, pwdCheckModuleArg in 2.6
    const schema = (await dm.ldap.search(
      { scope: 'base', attributes: ['attributeTypes'], paged: false },
      'cn=subschema'
    )) as unknown as { searchEntries: { attributeTypes?: string[] }[] };
    const defined = (name: string): boolean =>
      (schema.searchEntries[0].attributeTypes || []).some(type =>
        type.includes(`NAME '${name}'`)
      );
    const res = await request.get(api);
    const attributes = res.body.attributes as string[];
    expect(attributes).to.include.members(['pwdMaxAge', 'pwdMinLength']);
    expect(attributes).not.to.include.members(['pwdAttribute', 'cn']);
    for (const name of [
      'pwdMaxLength',
      'pwdMaxIdle',
      'pwdMinDelay',
      'pwdMaxDelay',
      'pwdCheckModuleArg',
      'pwdUseCheckModule',
    ])
      expect(attributes.includes(name), name).to.equal(defined(name));
  });

  it('lists every attribute when the schema cannot be read', async () => {
    const ldap = dm.ldap as unknown as { schemaIndex: () => Promise<unknown> };
    const schemaIndex = ldap.schemaIndex;
    ldap.schemaIndex = () => Promise.reject(new Error('unreadable'));
    try {
      const res = await request.get(api);
      expect(res.status).to.equal(200);
      expect(res.body.attributes).to.include.members([
        'pwdMaxLength',
        'pwdCheckModuleArg',
      ]);
    } finally {
      ldap.schemaIndex = schemaIndex;
    }
  });

  it('reads an attribute the default policy lacks as absent', async () => {
    const res = await request.get('/api/v1/password-policy');
    expect(res.status).to.equal(200);
    expect(res.body).to.include({
      pwdMaxAge: 31536000,
      pwdAllowUserChange: true,
    });
  });

  it('gives the checker class to a policy given a module argument', async () => {
    // pwdCheckModuleArg appeared in OpenLDAP 2.6
    const schema = (await dm.ldap.search(
      { scope: 'base', attributes: ['attributeTypes'], paged: false },
      'cn=subschema'
    )) as unknown as { searchEntries: { attributeTypes?: string[] }[] };
    const known = (schema.searchEntries[0].attributeTypes || []).some(type =>
      type.includes("NAME 'pwdCheckModuleArg'")
    );
    const arg = 'minQuality 3\nclass-digit 0123456789 0 1 0\n';
    const res = await request
      .patch(`${api}/aged`)
      .send({ pwdCheckModuleArg: arg });
    if (!known) {
      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('pwdCheckModuleArg');
      return;
    }
    expect(res.status, JSON.stringify(res.body)).to.equal(200);
    expect(res.body.pwdCheckModuleArg).to.equal(arg);
    const entry = (await dm.ldap.search(
      { scope: 'base', attributes: ['objectClass'], paged: false },
      `cn=aged,${policyBase}`
    )) as unknown as { searchEntries: { objectClass: string[] }[] };
    expect(entry.searchEntries[0].objectClass).to.include('pwdPolicyChecker');
  });

  it('takes a policy name as a value, not as a filter', async () => {
    const res = await request.get(`${api}/*`);
    expect(res.status).to.equal(404);
  });

  it('sets and removes attributes', async () => {
    let res = await request
      .patch(`${api}/software`)
      .send({ pwdMinLength: 12, pwdMustChange: false });
    expect(res.status).to.equal(200);
    expect(res.body).to.deep.include({
      pwdMinLength: 12,
      pwdMustChange: false,
    });

    res = await request.patch(`${api}/software`).send({ pwdMinLength: null });
    expect(res.status).to.equal(200);
    expect(res.body).not.to.have.property('pwdMinLength');
    expect(res.body).to.have.property('pwdMustChange', false);
  });

  it('accepts back what it served, but no change to a read-only value', async () => {
    const served = (await request.get(`${api}/software`)).body as Record<
      string,
      unknown
    >;
    let res = await request
      .patch(`${api}/software`)
      .send({ ...served, pwdInHistory: 5 });
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('pwdInHistory', 5);

    res = await request
      .patch(`${api}/software`)
      .send({ dn: (served.dn as string).toUpperCase(), pwdInHistory: 6 });
    expect(res.status).to.equal(200);

    res = await request
      .patch(`${api}/software`)
      .send({ pwdAttribute: 'userCertificate' });
    expect(res.status).to.equal(400);
  });

  it('applies to each account the policy it names', async () => {
    await dm.ldap.add(userDn, {
      objectClass: ['top', 'inetOrgPerson'],
      uid: 'ppolicy.mgmt',
      cn: 'Ppolicy Mgmt',
      sn: 'Mgmt',
      userPassword: 'Initial-Passw0rd',
      pwdPolicySubentry: `cn=aged,${policyBase}`,
    });

    let status = await request.get(
      '/api/v1/users/ppolicy.mgmt/password-status'
    );
    expect(status.status).to.equal(200);
    expect(status.body.policy).to.equal(`cn=aged,${policyBase}`);
    expect(status.body.daysUntilExpiration).to.equal(10);
    expect(status.body.isLocked).to.equal(false);
    expect(status.body.lockedAt).to.equal(null);
    expect(
      (await request.post('/api/v1/users/ppolicy.mgmt/unlock')).status
    ).to.equal(200);

    let expiring = await request.get(
      '/api/v1/password-policy/expiring-soon?days=14'
    );
    expect(
      (expiring.body.users as { dn: string }[]).map(u => u.dn.toLowerCase())
    ).to.include(userDn.toLowerCase());

    const res = await request
      .put('/api/v1/users/ppolicy.mgmt/password-policy')
      .send({ policy: 'software' });
    expect(res.status).to.equal(200);
    expect(res.body.policy).to.equal(`cn=software,${policyBase}`);

    status = await request.get('/api/v1/users/ppolicy.mgmt/password-status');
    expect(status.body.policy).to.equal(`cn=software,${policyBase}`);
    expect(status.body.expiresAt).to.equal(null);

    expiring = await request.get(
      '/api/v1/password-policy/expiring-soon?days=14'
    );
    expect(
      (expiring.body.users as { dn: string }[]).map(u => u.dn.toLowerCase())
    ).not.to.include(userDn.toLowerCase());
  });

  it('refuses a policy that is not a name', async () => {
    const res = await request
      .put('/api/v1/users/ppolicy.mgmt/password-policy')
      .send({ policy: 5 });
    expect(res.status).to.equal(400);
    expect(res.body.error).to.equal(
      'Invalid request: body.policy: Expected union value'
    );
  });

  it('refuses to delete a policy still applied, or the default one', async () => {
    expect((await request.delete(`${api}/software`)).status).to.equal(409);
    expect((await request.delete(`${api}/default`)).status).to.equal(409);
  });

  it('gives an account back the default policy', async () => {
    const res = await request
      .put('/api/v1/users/ppolicy.mgmt/password-policy')
      .send({ policy: null });
    expect(res.status).to.equal(200);
    expect(res.body.policy).to.equal(null);
    const again = await request
      .put('/api/v1/users/ppolicy.mgmt/password-policy')
      .send({ policy: null });
    expect(again.status).to.equal(200);

    const status = await request.get(
      '/api/v1/users/ppolicy.mgmt/password-status'
    );
    expect(status.body.policy).to.equal(`cn=default,${policyBase}`);
    expect(status.body.daysUntilExpiration).to.be.above(360);
  });

  it('refuses to assign an unknown policy', async () => {
    const res = await request
      .put('/api/v1/users/ppolicy.mgmt/password-policy')
      .send({ policy: 'nope' });
    expect(res.status).to.equal(404);
    const missing = await request
      .put('/api/v1/users/ppolicy.mgmt/password-policy')
      .send({});
    expect(missing.status).to.equal(400);
  });

  it('deletes a policy no longer applied', async () => {
    expect((await request.delete(`${api}/software`)).status).to.equal(200);
    expect((await request.get(`${api}/software`)).status).to.equal(404);
  });

  it('reports no default policy rather than guessing among several', async () => {
    dm.config.ppolicy_default_dn = '';
    try {
      const plugin = new PasswordPolicy(dm) as unknown as {
        readPolicyConfig(): Promise<{ dn?: string }>;
      };
      expect((await plugin.readPolicyConfig()).dn).to.equal(undefined);
    } finally {
      dm.config.ppolicy_default_dn = `cn=default,${policyBase}`;
    }
  });

  it('answers a missing policy base as holding no policy', async () => {
    dm.config.ppolicy_base = `ou=absent,${policyBase}`;
    try {
      const list = await request.get(api);
      expect(list.status).to.equal(200);
      expect(list.body.policies).to.deep.equal([]);
      expect((await request.get(`${api}/default`)).status).to.equal(404);
      const created = await request.post(api).send({ cn: 'nowhere' });
      expect(created.status).to.equal(404);
      expect(created.body.error).to.include('--ppolicy-base');
    } finally {
      dm.config.ppolicy_base = policyBase;
    }
  });

  it('does not replace a configured default that holds no policy', async () => {
    dm.config.ppolicy_default_dn = `cn=absent,${policyBase}`;
    // A base holding exactly one policy, which discovery would adopt
    dm.config.ppolicy_base = `cn=default,${policyBase}`;
    try {
      const plugin = new PasswordPolicy(dm) as unknown as {
        readPolicyConfig(): Promise<{ dn?: string }>;
      };
      expect((await plugin.readPolicyConfig()).dn).to.equal(undefined);
    } finally {
      dm.config.ppolicy_default_dn = `cn=default,${policyBase}`;
      dm.config.ppolicy_base = policyBase;
    }
  });
});

describe('PasswordPolicy.calculateStatus', () => {
  interface Status {
    expiresAt: string | null;
    daysUntilExpiration: number | null;
    isExpired: boolean;
  }

  const calculate = (pwdMaxAge: number): Status => {
    const plugin = Object.create(PasswordPolicy.prototype) as {
      settings: { ppolicy_warn_days: number };
      calculateStatus(
        dn: string,
        entry: Record<string, unknown>,
        policy: Record<string, unknown>
      ): Status;
    };
    Object.defineProperty(plugin, 'settings', {
      value: { ppolicy_warn_days: 14 },
    });
    return plugin.calculateStatus(
      'uid=jdoe,ou=users,dc=example,dc=com',
      {
        dn: 'uid=jdoe,ou=users,dc=example,dc=com',
        pwdChangedTime: '20261031120000Z',
      },
      {
        dn: 'cn=default,ou=policies,dc=example,dc=com',
        pwdMaxAge,
      }
    );
  };

  it('reports an expiry beyond the date range as no expiry', () => {
    const status = calculate(9_000_000_000_000);

    expect(status.expiresAt).to.equal(null);
    expect(status.daysUntilExpiration).to.equal(null);
    expect(status.isExpired).to.equal(false);
  });

  it('keeps an expiry inside the date range', () => {
    const status = calculate(864000);

    expect(status.expiresAt).to.not.equal(null);
    expect(Number.isNaN(Date.parse(status.expiresAt as string))).to.equal(
      false
    );
    expect(Number.isSafeInteger(status.daysUntilExpiration)).to.equal(true);
  });
});
