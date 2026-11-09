/**
 * The write half of the LDAP operation pipeline: add, modify, rename, move
 * and delete, with their hooks and cache invalidation.
 */
import type { Request } from 'express';
import { Attribute, Change, Control } from 'ldapts';
import type winston from 'winston';

import type { Config } from '../../config/args.js';
import type { DM } from '../../bin/index.js';
import { escapeDnValue, rdnTypes } from '../utils.js';
import { changeContext } from '../changeContext.js';
import { outsideOperation, runOperation } from '../operation.js';
import { currentRequest } from '../requestContext.js';
import { timedLdap } from '../metrics.js';
import { extractLdapCode } from '../ldapCodes.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import type {
  AttributesList,
  AttributeValue,
  ModifyOptions,
  ModifyRequest,
} from '../ldapActions.js';

import {
  assertHasValue,
  withCode,
  ldapAddError,
  ldapModifyError,
  ldapRenameError,
  ldapWriteError,
} from './errors.js';
import type LdapPool from './pool.js';
import { membersNamed } from './searchCache.js';
import type SearchCache from './searchCache.js';
import type DirectorySchema from './schema.js';
import type CallerView from './callerView.js';

/**
 * The values of one attribute as `ldapts` takes them: a single value becomes
 * a one-element array, an array keeps its kind.
 */
function attributeValues(value: AttributeValue): string[] | Buffer[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [value];
}

export interface LdapHost {
  readonly parent: DM;
  readonly config: Config;
  readonly base: string;
  readonly logger: winston.Logger;
  readonly pool: LdapPool;
  readonly cache: SearchCache;
  readonly schema: DirectorySchema;
  readonly caller: CallerView;
}

const PERMISSIVE_MODIFY = '1.2.840.113556.1.4.1413';

/** The hooks a write launches once its "done" hooks have returned */
type EndHook = 'ldapmodifyend' | 'ldapdeleteend' | 'ldaprenameend';

export async function add(
  host: LdapHost,
  dn: string,
  entry: AttributesList,
  req?: Request
): Promise<boolean> {
  req ??= currentRequest();
  dn = setDn(host, dn);
  await host.schema.canonicalAttributes(entry);
  if (
    (!entry.objectClass || entry.objectClass.length === 0) &&
    host.config.user_class
  ) {
    entry.objectClass = host.config.user_class;
  }
  // Convert Buffer/Buffer[] values to string/string[]
  const sanitizedEntry: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (Buffer.isBuffer(value)) {
      sanitizedEntry[key] = value.toString();
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      Buffer.isBuffer(value[0])
    ) {
      sanitizedEntry[key] = (value as Buffer[]).map(v => v.toString());
    } else {
      sanitizedEntry[key] = value as string | string[];
    }
  }
  [dn, entry] = await host.parent.hookBus.chain('ldapaddrequest', [
    dn,
    sanitizedEntry,
    req,
  ]);

  const members = membersNamed(entry);

  // Convert to Attribute objects
  const attributes: Attribute[] = [];
  for (const [key, value] of Object.entries(entry)) {
    assertHasValue(key, value);
    const values = attributeValues(value);
    attributes.push(
      new Attribute({
        type: key,
        values,
      })
    );
  }

  const pooled = await host.pool.acquire();
  try {
    // Dropped before the write is issued as well as after it lands. The
    // directory commits somewhere inside this `await`, and the invalidation
    // below runs only once the answer has come back: a read landing in that
    // round trip would find the entry still cached and answer what it held
    // before the write. Dropping it early costs a miss if the write then
    // fails, which is harmless, and the cache's generation keeps a read the
    // overtook from putting it back.
    host.cache.invalidate(dn);
    // A group created with members changes their `memberOf`
    for (const member of members) host.cache.invalidate(member);
    await timedLdap('add', () => pooled.client.add(dn, attributes));
    // Drop any cached read of this DN.
    //
    // Not to lift a negative result: a base-scope read of a DN that is not
    // there throws and caches nothing, and an add on a DN that *is* there
    // is refused by the directory. What it covers is the entry read and
    // cached here, then deleted by something else — another replica, LSC,
    // ldapmodify — and re-created through this call, where the cache would
    // otherwise keep answering the entry that used to carry this DN.
    host.cache.invalidate(dn);
    for (const member of members) host.cache.invalidate(member);
    host.parent.hookBus.notify('ldapadddone', dn, entry, changeContext(req));
  } catch (error) {
    throw ldapAddError(dn, error);
  } finally {
    host.pool.release(pooled);
  }
  // After the connection is released, so none is held while subscribers
  // run; a failure is logged and goes no further, the add having succeeded
  await host.parent.hookBus.notifyAndWait(
    'ldapaddafter',
    dn,
    entry,
    changeContext(req)
  );
  return true;
}
export async function modify(
  host: LdapHost,
  dn: string,
  changes: ModifyRequest,
  req?: Request,
  options: ModifyOptions = {}
): Promise<boolean> {
  req ??= currentRequest();
  const op: number = opNumber(host);
  const done: Promise<void>[] = [];
  try {
    return await runOperation(op, () =>
      applyModify(host, dn, changes, req, options, op, done)
    );
  } finally {
    endOperation(host, done, 'ldapmodifyend', op);
  }
}
async function applyModify(
  host: LdapHost,
  dn: string,
  changes: ModifyRequest,
  req: Request | undefined,
  options: ModifyOptions,
  op: number,
  done: Promise<void>[]
): Promise<boolean> {
  dn = setDn(host, dn);
  const ldapChanges: Change[] = [];
  await host.schema.canonicalChanges(changes);
  [dn, changes] = await host.parent.hookBus.chain('ldapmodifyrequest', [
    dn,
    changes,
    op,
    req,
  ]);
  if (changes.add) {
    for (const [key, value] of Object.entries(changes.add)) {
      assertHasValue(key, value);
      ldapChanges.push(
        new Change({
          operation: 'add',
          modification: new Attribute({
            type: key,
            values: attributeValues(value),
          }),
        })
      );
    }
  }
  if (changes.replace) {
    for (const [key, value] of Object.entries(changes.replace)) {
      ldapChanges.push(
        new Change({
          operation: 'replace',
          modification: new Attribute({
            type: key,
            values: attributeValues(value),
          }),
        })
      );
    }
  }

  if (changes.delete) {
    if (Array.isArray(changes.delete)) {
      for (const attr of changes.delete)
        ldapChanges.push(
          new Change({
            operation: 'delete',
            modification: new Attribute({ type: attr, values: [] }),
          })
        );
    } else {
      for (const [key, value] of Object.entries(changes.delete)) {
        const change = new Change({
          operation: 'delete',
          modification: value
            ? new Attribute({
                type: key,
                values: attributeValues(value),
              })
            : new Attribute({ type: key }),
        });
        ldapChanges.push(change);
      }
    }
  }
  // A change of a group's members changes their `memberOf`: those it names,
  // and those a replace or a delete of every value removes, which only
  // their cached reads still tie to the group.
  const invalidate = (): void => {
    host.cache.invalidate(dn);
    host.cache.invalidateMembership(dn, changes);
  };
  if (ldapChanges.length !== 0) {
    const controls = options.permissive
      ? [new Control(PERMISSIVE_MODIFY, { critical: false })]
      : undefined;
    const send = (): Promise<void> =>
      host.pool.withConnection(client =>
        timedLdap('modify', () => client.modify(dn, ldapChanges, controls))
      );
    try {
      // Dropped before the write is issued as well as after it lands. The
      // directory commits somewhere inside this `await`, and the invalidation
      // below runs only once the answer has come back: a read landing in that
      // round trip would find the entry still cached and answer what it held
      // before the write. Dropping it early costs a miss if the write then
      // fails, which is harmless, and the cache's generation keeps a read the
      // overtook from putting it back.
      invalidate();
      try {
        await send();
      } catch (error) {
        // Repaired only once the directory refuses the classes (65), so a
        // write it takes costs no read. The connection is given back before
        // the repair reads: holding it meanwhile could exhaust the pool.
        if (extractLdapCode(error) !== 65) throw error;
        const repair = await host.schema.classRepair(
          dn,
          changes,
          options.declaredClasses
        );
        // `allowed`: a writer gave the entry its classes after the refusal,
        // so the change is sent again as it is
        if (repair !== 'allowed' && repair.length === 0) throw error;
        const repairChange =
          repair === 'allowed'
            ? undefined
            : new Change({
                operation: 'add',
                modification: new Attribute({
                  type: 'objectClass',
                  values: repair,
                }),
              });
        if (repairChange) ldapChanges.push(repairChange);
        // The repair's read may have cached the entry again
        host.cache.invalidate(dn);
        try {
          await send();
        } catch (retry) {
          // A writer in between may have given it the class already, and
          // adding it again is refused (20). What the repair wanted is then
          // there.
          if (!repairChange || extractLdapCode(retry) !== 20) throw retry;
          ldapChanges.splice(ldapChanges.indexOf(repairChange), 1);
          await send();
        }
      }
      invalidate();
      done.push(
        host.parent.hookBus.notifyAndWait(
          'ldapmodifydone',
          dn,
          changes,
          op,
          options.context ?? changeContext(req)
        )
      );
      return true;
    } catch (error) {
      host.logger.warn(
        `Changes that failed: ${dn}, ${JSON.stringify(ldapChanges)}`
      );
      throw ldapModifyError(dn, error);
    }
  } else {
    // Two different things end up here, and only one of them is routine.
    //
    // A caller that asked for nothing: a SCIM PATCH whose operations all
    // turn out to be no-ops still comes through so the authorization hooks
    // run, and an empty modify touches the directory not at all.
    //
    // A caller that asked for something and got nothing emitted: every
    // change it named was dropped while building the request. Nothing
    // reaches the directory and the call still answers, so a translation
    // bug upstream is invisible from the outside. That is worth a line
    // someone will see.
    const asked =
      Object.keys(changes.add || {}).length > 0 ||
      Object.keys(changes.replace || {}).length > 0 ||
      (Array.isArray(changes.delete)
        ? changes.delete.length > 0
        : Object.keys(changes.delete || {}).length > 0);
    if (asked) {
      host.logger.warn(
        `Modify on ${dn} asked for changes but emitted none; nothing was written`
      );
    } else {
      host.logger.debug(`Modify on ${dn} had nothing to apply`);
    }
    done.push(
      host.parent.hookBus.notifyAndWait(
        'ldapmodifydone',
        dn,
        {},
        op,
        options.context ?? changeContext(req)
      )
    );
    return false;
  }
}
export async function rename(
  host: LdapHost,
  dn: string,
  newRdn: string,
  req?: Request
): Promise<boolean> {
  req ??= currentRequest();
  dn = setDn(host, dn);
  newRdn = setDn(host, newRdn);
  // The directory writes the values of the new RDN on the entry, where no
  // check of a write sees them: `cn=x+twakeDepartmentLink=…` linked a
  // group past the move check. One value, of the attribute the entry is
  // already named by
  const named = rdnTypes(dn);
  const renamed = rdnTypes(newRdn);
  if (renamed.length !== 1 || !named.includes(renamed[0]))
    throw new BadRequestError(
      `${newRdn}: an entry is renamed by one value of the attribute it is named by`
    );
  const op: number = opNumber(host);
  const done: Promise<void>[] = [];
  try {
    return await runOperation(op, () =>
      applyRename(host, dn, newRdn, req, done)
    );
  } finally {
    endOperation(host, done, 'ldaprenameend', op);
  }
}
async function applyRename(
  host: LdapHost,
  dn: string,
  newRdn: string,
  req: Request | undefined,
  done: Promise<void>[]
): Promise<boolean> {
  [dn, newRdn] = await host.parent.hookBus.chain('ldaprenamerequest', [
    dn,
    newRdn,
    req,
  ]);
  const pooled = await host.pool.acquire();
  try {
    // Dropped before the write is issued as well as after it lands. The
    // directory commits somewhere inside this `await`, and the invalidation
    // below runs only once the answer has come back: a read landing in that
    // round trip would find the entry still cached and answer what it held
    // before the write. Dropping it early costs a miss if the write then
    // fails, which is harmless, and the cache's generation keeps a read the
    // overtook from putting it back.
    host.cache.invalidate(dn);
    host.cache.invalidate(newRdn);
    host.cache.invalidateReferences(dn);
    await timedLdap('rename', () => pooled.client.modifyDN(dn, newRdn));
    // Invalidate both ends. A base-scope read of the old DN would
    // otherwise keep answering the entry that is no longer there, and a
    // read cached under the new DN — of whatever used to carry it — would
    // hide the entry that just took its place. `invalidate` drops the
    // subtree too: renaming a container moves every DN under it. And the
    // directory rewrites what named the old DN — the members' `memberOf`
    // of a renamed group, the references `refint` follows.
    host.cache.invalidate(dn);
    host.cache.invalidate(newRdn);
    host.cache.invalidateReferences(dn);
    done.push(
      host.parent.hookBus.notifyAndWait(
        'ldaprenamedone',
        dn,
        newRdn,
        changeContext(req)
      )
    );
    return true;
  } catch (error) {
    throw ldapRenameError('LDAP rename error', dn, newRdn, error);
  } finally {
    host.pool.release(pooled);
  }
}
/**
 * Move an entry to a new location (different parent)
 * Uses LDAP modifyDN with full DN to change both RDN and parent
 *
 * Not judged, request or not: a move is the server's, made for a write
 * already judged — the trash turning a delete into one. A route moving an
 * entry for its caller uses {@link rename}, which is judged.
 *
 * Note: ldapts provides a high-level API that accepts a full DN as the second parameter,
 * unlike the standard LDAP modifyDN which expects (newRDN, deleteOldRDN, newSuperior).
 * ldapts automatically parses the full DN and extracts the newRDN and newSuperior components
 * before sending the proper LDAP modifyDN request to the server.
 *
 * @param dn - Current DN (e.g., "uid=user1,ou=users,dc=example,dc=com")
 * @param newDn - Full new DN (e.g., "uid=user1,ou=trash,dc=example,dc=com")
 *                ldapts will extract newRDN="uid=user1" and newSuperior="ou=trash,dc=example,dc=com"
 * @param req - Request behind the move, when there is one
 */
export async function move(
  host: LdapHost,
  dn: string,
  newDn: string,
  req?: Request
): Promise<boolean> {
  req ??= currentRequest();
  dn = setDn(host, dn);
  newDn = setDn(host, newDn);
  const pooled = await host.pool.acquire();
  try {
    // Dropped before the write is issued as well as after it lands. The
    // directory commits somewhere inside this `await`, and the invalidation
    // below runs only once the answer has come back: a read landing in that
    // round trip would find the entry still cached and answer what it held
    // before the write. Dropping it early costs a miss if the write then
    // fails, which is harmless, and the cache's generation keeps a read the
    // overtook from putting it back.
    host.cache.invalidate(dn);
    host.cache.invalidate(newDn);
    host.cache.invalidateReferences(dn);
    await timedLdap('rename', () => pooled.client.modifyDN(dn, newDn));
    // Invalidate both ends — see rename() above for why both matter.
    host.cache.invalidate(dn);
    host.cache.invalidate(newDn);
    host.cache.invalidateReferences(dn);
    // A move is a modifyDN, so it is a rename: the plugins that watch a
    // rename watch a move, and the two caches that outlive the search cache
    // (the authz group cache, the identity → DN resolution cache) are
    // dropped by the same hook. `ldaprenamerequest` is deliberately not
    // launched: it is an authorization hook, and this write has already
    // been judged by the `ldap*request` hook of whatever drove it —
    // re-running it here would judge the same write twice. Outside the
    // operation a request hook may have moved it from (the trash moves
    // from ldapdeleterequest): this move is not that write.
    void outsideOperation(() =>
      host.parent.hookBus.notify(
        'ldaprenamedone',
        dn,
        newDn,
        changeContext(req)
      )
    );
    host.logger.debug(`LDAP move: ${dn} -> ${newDn}`);
    return true;
  } catch (error) {
    throw ldapRenameError('LDAP move error', dn, newDn, error);
  } finally {
    host.pool.release(pooled);
  }
}
export async function remove(
  host: LdapHost,

  dn: string | string[],
  req?: Request,
  options: Pick<ModifyOptions, 'context'> = {}
): Promise<boolean> {
  req ??= currentRequest();
  const requested = (Array.isArray(dn) ? dn : [dn]).map(d => setDn(host, d));
  const op: number = opNumber(host);
  const done: Promise<void>[] = [];
  try {
    return await runOperation(op, () =>
      applyDelete(host, requested, req, options, done)
    );
  } finally {
    endOperation(host, done, 'ldapdeleteend', op);
  }
}
async function applyDelete(
  host: LdapHost,
  dn: string | string[],
  req: Request | undefined,
  options: Pick<ModifyOptions, 'context'>,
  done: Promise<void>[]
): Promise<boolean> {
  [dn] = await host.parent.hookBus.chain('ldapdeleterequest', [dn, req]);

  await host.pool.withConnection(async client => {
    for (const entry of dn) {
      try {
        // Dropped before the write is issued as well as after it lands. The
        // directory commits somewhere inside this `await`, and the invalidation
        // below runs only once the answer has come back: a read landing in that
        // round trip would find the entry still cached and answer what it held
        // before the write. Dropping it early costs a miss if the write then
        // fails, which is harmless, and the cache's generation keeps a read the
        // overtook from putting it back.
        host.cache.invalidate(entry);
        host.cache.invalidateReferences(entry);
        await timedLdap('delete', () => client.del(entry));
        // Invalidate cache for this DN, and for what named it: a deleted
        // group leaves its members' `memberOf`
        host.cache.invalidate(entry);
        host.cache.invalidateReferences(entry);
      } catch (error) {
        const code = extractLdapCode(error);
        throw code === 32
          ? withCode(new NotFoundError(`Entry ${entry} not found`), code)
          : ldapWriteError('LDAP delete error', entry, error);
      }
      done.push(
        host.parent.hookBus.notifyAndWait(
          'ldapdeletedone',
          entry,
          options.context ?? changeContext(req)
        )
      );
    }
  });
  return true;
}
export function setDn(host: LdapHost, dn: string): string {
  if (!/=/.test(dn)) {
    dn = `${host.config.ldap_user_main_attribute as string}=${escapeDnValue(dn)},${host.base}`;
  } else if (!/,/.test(dn)) {
    dn += `,${host.base}`;
  }
  return dn;
}
/**
 * Launch the "end" hooks of a write once its "done" hooks have returned,
 * whatever became of it: written, refused by a request hook, taken out of
 * the request by one, or failed in the directory, with its operation
 * number. A plugin keeping state from a request hook to a done one, keyed
 * by `currentOperation()`, drops there what no done hook took.
 */
function endOperation(
  host: LdapHost,
  done: Promise<void>[],
  hook: EndHook,
  op: number
): void {
  if (!host.parent.hookBus.has(hook)) return;
  void Promise.all(done).then(() =>
    host.parent.hookBus.notify(hook as 'ldapmodifyend', op)
  );
}
export function opNumber(host: LdapHost): number {
  return host.parent.operationSequence++;
}
