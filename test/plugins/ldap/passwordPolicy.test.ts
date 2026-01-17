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
