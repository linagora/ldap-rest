import fetch from 'node-fetch';

import DmPlugin from '../../abstract/plugin';
import type { AttributesList, SearchResult } from '../../lib/ldapActions';
import { Hooks } from '../../hooks';

export default class James extends DmPlugin {
  name = 'james';

  dependencies = {
    onLdapChange: 'core/ldap/onChange',
    ldapGroups: 'core/ldap/groups',
  };

  hooks: Hooks = {
    onLdapMailChange: (dn: string, oldmail: string, newmail: string) => {
      return this._try(
        'onLdapMailChange',
        `${this.config.james_webadmin_url}/users/${oldmail}/rename/${newmail}?action=rename`,
        'POST',
        dn,
        null,
        { oldmail, newmail }
      );
    },
    onLdapQuotaChange: (
      dn: string,
      mail: string,
      oldQuota: number,
      newQuota: number
    ) => {
      return this._try(
        'onLdapQuotaChange',
        `${this.config.james_webadmin_url}/quota/users/${mail}/size`,
        'PUT',
        dn,
        newQuota.toString(),
        { oldQuota, newQuota }
      );
    },

    // Group/mailing list hooks
    ldapgroupadddone: async (args: [string, AttributesList]) => {
      const [dn, attributes] = args;
      const mail = attributes.mail as string | string[] | undefined;

      // Only handle groups with a mail attribute (mailing lists)
      if (!mail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      const mailStr = Array.isArray(mail) ? String(mail[0]) : String(mail);
      const members =
        (attributes.member as string | string[] | undefined) || [];
      const memberList: string[] = Array.isArray(members) ? members : [members];

      this.logger.debug(
        `Creating mailing list ${mailStr} in James with ${memberList.length} members`
      );

      // Get email addresses for all members
      const memberMails = await this.getMemberEmails(memberList);

      // Add each member to the James address group
      for (const memberMail of memberMails) {
        await this._try(
          'ldapgroupadddone',
          `${this.config.james_webadmin_url}/address/groups/${mailStr}/${memberMail}`,
          'PUT',
          dn,
          null,
          { groupMail: mailStr, memberMail }
        );
      }
    },

    ldapgroupmodifydone: async (
      args: [
        string,
        {
          add?: AttributesList;
          replace?: AttributesList;
          delete?: string[] | AttributesList;
        },
        number,
      ]
    ) => {
      const [dn, changes] = args;

      // Get the group's mail address
      const groupMail = await this.getGroupMail(dn);
      if (!groupMail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      // Handle member additions
      if (changes.add?.member) {
        const addMember = changes.add.member as string | string[];
        const membersToAdd = Array.isArray(addMember) ? addMember : [addMember];
        const memberMails = await this.getMemberEmails(membersToAdd);

        for (const memberMail of memberMails) {
          await this._try(
            'ldapgroupmodifydone',
            `${this.config.james_webadmin_url}/address/groups/${groupMail}/${memberMail}`,
            'PUT',
            dn,
            null,
            { groupMail, memberMail, action: 'add' }
          );
        }
      }

      // Handle member deletions
      if (this.isAttributesList(changes.delete)) {
        const deleteMember = changes.delete.member as
          | string
          | string[]
          | undefined;
        if (deleteMember) {
          const membersToDelete = Array.isArray(deleteMember)
            ? deleteMember
            : [deleteMember];
          const memberMails = await this.getMemberEmails(membersToDelete);

          for (const memberMail of memberMails) {
            await this._try(
              'ldapgroupmodifydone',
              `${this.config.james_webadmin_url}/address/groups/${groupMail}/${memberMail}`,
              'DELETE',
              dn,
              null,
              { groupMail, memberMail, action: 'delete' }
            );
          }
        }
      }
    },

    ldapgroupdeletedone: async (dn: string) => {
      // Get the group's mail address before deletion
      const groupMail = await this.getGroupMail(dn);
      if (!groupMail) {
        this.logger.debug(
          `Group ${dn} has no mail attribute, skipping James sync`
        );
        return;
      }

      // Delete the entire address group from James
      await this._try(
        'ldapgroupdeletedone',
        `${this.config.james_webadmin_url}/address/groups/${groupMail}`,
        'DELETE',
        dn,
        null,
        { groupMail }
      );
    },
  };

  /**
   * Type guard to check if delete operation is an AttributesList
   */
  private isAttributesList(
    value: string[] | AttributesList | undefined
  ): value is AttributesList {
    return (
      value !== undefined && typeof value === 'object' && !Array.isArray(value)
    );
  }

  /**
   * Get email addresses for a list of member DNs
   */
  async getMemberEmails(memberDns: string[]): Promise<string[]> {
    const mailAttr = this.config.mail_attribute || 'mail';
    const emails: string[] = [];

    for (const memberDn of memberDns) {
      // Skip dummy members
      if (memberDn === this.config.group_dummy_user) continue;

      try {
        const result = (await this.server.ldap.search(
          { paged: false, scope: 'base', attributes: [mailAttr] },
          memberDn
        )) as SearchResult;

        if (result.searchEntries && result.searchEntries.length > 0) {
          const mail = result.searchEntries[0][mailAttr];
          if (mail) {
            const mailStr = Array.isArray(mail)
              ? String(mail[0])
              : String(mail);
            emails.push(mailStr);
          }
        }
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        this.logger.debug(`Could not get email for member ${memberDn}: ${err}`);
      }
    }

    return emails;
  }

  /**
   * Get the mail address for a group DN
   */
  async getGroupMail(groupDn: string): Promise<string | null> {
    try {
      const result = (await this.server.ldap.search(
        { paged: false, scope: 'base', attributes: ['mail'] },
        groupDn
      )) as SearchResult;

      if (result.searchEntries && result.searchEntries.length > 0) {
        const mail = result.searchEntries[0].mail;
        if (mail) {
          return Array.isArray(mail) ? String(mail[0]) : String(mail);
        }
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      this.logger.debug(`Could not get mail for group ${groupDn}: ${err}`);
    }

    return null;
  }

  async _try(
    hookname: string,
    url: string,
    method: string,
    dn: string,
    body: string | null,
    fields: object
  ): Promise<void> {
    // Prepare log
    const log = {
      plugin: this.name,
      event: `${hookname}`,
      result: 'error',
      dn,
      ...fields,
    };
    try {
      const opts: {
        method: string;
        body?: string | null;
        headers?: { Authorization?: string };
      } = { method };
      if (body) Object.assign(opts, { body });
      if (this.config.james_webadmin_token) {
        if (!opts.headers) opts.headers = {};
        opts.headers.Authorization = `Bearer ${this.config.james_webadmin_token}`;
      }
      const res = await fetch(url, opts);
      if (!res.ok) {
        this.logger.error({
          ...log,
          http_status: res.status,
          http_status_text: res.statusText,
        });
      } else {
        this.logger.info({
          ...log,
          result: 'success',
          http_status: res.status,
        });
      }
    } catch (err) {
      this.logger.error({
        ...log,
        error: err,
      });
    }
  }
}
