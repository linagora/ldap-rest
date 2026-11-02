/**
 * The Twake groups a space is made of, as another plugin reads them.
 *
 * @see docs/plugin-development/services.md
 */
import type { Request, Response } from 'express';

import type { AttributesList } from '../ldapActions';

import { serviceToken } from './index';

/** A request's page, search and sort, as the list routes read them. */
export interface Page {
  page: number;
  limit: number;
  offset: number;
  search?: string;
  sortBy?: string;
  desc: boolean;
}

export interface TwakeGroupsApi {
  readonly cn: string;
  readonly maxPage: number;
  readonly userAttribute: string;
  organizationOf(dn: string): string | undefined;
  groupBaseOf(org: string): string;
  userBaseOf(org: string): string;
  organizationRoute(
    context: string,
    handler: (req: Request, res: Response, org: string) => Promise<void>,
    plugin?: string
  ): (req: Request, res: Response) => Promise<void>;
  page(req: Request, sortable: string[]): Page;
  sorted<T extends Record<string, unknown>>(
    items: T[],
    sortBy: string | undefined,
    desc: boolean
  ): T[];
  groupOf(org: string, entry: AttributesList): Record<string, unknown>;
  groups(
    org: string,
    filter: string,
    attributes?: string[],
    req?: Request
  ): Promise<AttributesList[]>;
  memberPage(
    p: Page,
    org: string,
    names: string[],
    extra?: (username: string) => Record<string, unknown>,
    req?: Request
  ): Promise<{
    members: Record<string, unknown>[];
    pagination: Record<string, number | boolean>;
  }>;
  users(
    org: string,
    usernames: string[],
    attributes: string[],
    req?: Request
  ): Promise<AttributesList[]>;
  tombstonesOf(org: string): Promise<string[]>;
  checkOrganization(org: string, req?: Request): Promise<void>;
}

export const TwakeGroupsService = serviceToken<TwakeGroupsApi>('twake-groups');
