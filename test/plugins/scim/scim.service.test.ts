import { expect } from 'chai';
import { providedService } from '@ldap-rest/core/lib/services';
import { ScimService } from '@ldap-rest/core/lib/services/scim';

import { DM } from '../../helpers/dm';
import Scim from '../../../src/plugins/scim/scim';

describe('SCIM service', () => {
  it('provides the configured lock', async () => {
    const dm = new DM();
    Object.assign(dm.config, {
      scim_user_lock_attribute: 'nsAccountLock',
      scim_user_lock_value: 'TRUE',
    });
    await dm.ready;
    await dm.registerPlugin('scim', new Scim(dm));
    const scim = providedService(dm.services, ScimService);
    expect(scim?.userLockAttribute).to.equal('nsAccountLock');
    expect(scim?.userLockValue).to.equal('TRUE');
  });
});
