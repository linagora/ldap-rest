/**
 * @module core/helloworld
 * Demo plugin, add /hello API + consumes 'hello' hook
 * @author Xavier Guimard <xguimard@linagora.com>
 */

import type { Express, Request, Response } from 'express';

import DmPlugin, { type Role, asyncHandler } from '../../abstract/plugin';

/**
 * @openapi-component
 * Hello:
 *   type: object
 *   description: Response returned by the hello-world demo endpoint.
 *   properties:
 *     message:
 *       type: string
 *       description: Static greeting string.
 *       example: Hello
 *     hookResults:
 *       type: array
 *       description: |
 *         Results collected from every function registered on the `hello`
 *         hook.  Empty when no hook listeners are installed.
 *       items: {}
 *       example: []
 *   example:
 *     message: Hello
 *     hookResults: []
 */
export default class HelloWorld extends DmPlugin {
  name = 'hello';
  roles: Role[] = ['demo'] as const;

  api(app: Express): void {
    /**
     * @openapi
     * summary: Demo hello-world endpoint
     * description: |
     *   Exists exclusively as a minimal example for plugin development.
     *   The handler fires the `hello` hook and collects the results from
     *   every registered listener into `hookResults`.  In a production
     *   deployment this plugin is normally disabled; enabling it is safe
     *   but adds no functional value.
     * responses:
     *   '200':
     *     description: Greeting with hook results.
     *     content:
     *       application/json:
     *         schema: { $ref: '#/components/schemas/Hello' }
     *         example:
     *           message: Hello
     *           hookResults: []
     */
    app.get(
      `${this.config.api_prefix}/hello`,
      asyncHandler(async (req: Request, res: Response) => {
        const response = { message: 'Hello', hookResults: [] as unknown[] };
        if (this.server.hooks && this.server.hooks['hello']) {
          for (const hook of this.server.hooks['hello']) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            response.hookResults.push(await hook());
          }
        }
        res.json(response);
      })
    );
  }
}
