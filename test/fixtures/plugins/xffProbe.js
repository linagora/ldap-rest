/**
 * A route that reports `X-Forwarded-For` as it reaches a handler.
 *
 * Loaded from the parallel batch — its module is not in `priority.json` —
 * so it registers its route as early as any plugin can, which is what makes
 * it a probe for whether a priority plugin still runs first.
 *
 * Plain JavaScript on purpose: the loader hands a `--plugin` entry to
 * `import()` as written, and a `.js` specifier pointing at a `.ts` file is
 * not resolved by every runner.
 */
export default class XffProbe {
  constructor(server) {
    this.server = server;
    this.name = 'xffProbe';
  }

  api(app) {
    app.get('/api/xff-probe', (req, res) => {
      res.json({ xff: req.headers['x-forwarded-for'] ?? null });
    });
  }
}
