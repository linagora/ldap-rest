import fs from 'fs';
import supertest from 'supertest';

import { DM } from '../../src/bin';
import Static from '../../src/plugins/static';
import { expect } from 'chai';

const dir = './test/__plugins__/static';
let dm: DM;
let plugin: Static;

describe('static', () => {
  describe('path configuration', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'test';
      process.env.DM_STATIC_PATH = dir;
      process.env.DM_LDAP_BASE = 'dc=example,dc=com';
      dm = new DM();
      await dm.ready;
      try {
        fs.rmSync(dir, { recursive: true });
      } catch (e) {}
    });

    afterEach(() => {
      try {
        fs.rmSync(dir, { recursive: true });
      } catch (e) {}
    });

    it('should fail when directory does not exist', async () => {
      let err: Error | null = null;
      try {
        plugin = new Static(dm);
        await dm.registerPlugin('static', plugin);
        expect.fail('Should have failed');
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.an('error');
      expect(err?.message).to.match(/Bad directory/);
    });

    it('should fail when path is not a directory', async () => {
      let err: Error | null = null;
      try {
        fs.writeFileSync(dir, 'Hello');
        plugin = new Static(dm);
        await dm.registerPlugin('static', plugin);
        expect.fail('Should have failed');
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.an('error');
      expect(err?.message).to.match(/Bad directory/);
    });

    it('should return static content', async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/test.txt`, 'Hello World');
      plugin = new Static(dm);
      await dm.registerPlugin('static', plugin);
      const request = supertest(dm.app);
      const res = await request.get('/static/test.txt');
      expect(res.status).to.equal(200);
      expect(res.text).to.equal('Hello World');
    });
  });

  describe('default path', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'test';
      delete process.env.DM_STATIC_PATH;
      dm = new DM();
      await dm.ready;
    });

    it('should use default paths and replace parameters', async () => {
      plugin = new Static(dm);
      await dm.registerPlugin('static', plugin);
      const request = supertest(dm.app);
      const res = await request.get('/static/schemas/twake/groups.json');
      expect(res.status).to.equal(200);
      expect(res.type).to.equal('application/json');
      expect(JSON.stringify(res.body)).to.match(/dc=example/);
    });
  });
});
