#!/usr/bin/env tsx
/**
 * Build the static site published to GitHub Pages.
 *
 * Layout:
 *   _site/
 *     index.html        Landing page (intro extracted from README.md)
 *     openapi.json      Copy of the generated OpenAPI spec
 *     api/index.html    Redoc viewer pointing at ../openapi.json
 *
 * Run after `npm run generate:openapi` so the spec is up to date.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = path.join(__dirname, '..');
const out = path.join(root, '_site');

const REPO_URL = 'https://github.com/linagora/ldap-rest';
const SITE_TITLE = 'LDAP-Rest';

function rmrf(p: string): void {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function extractReadmeIntro(readme: string): string {
  // Keep everything from the first `# ` heading up to (excluding) the
  // `## Documentation` section, which would otherwise pull in a long list
  // of links pointing into the repo (which is fine on GitHub but noisy on
  // the landing page where we already link to the repo).
  const lines = readme.split('\n');
  const startIdx = lines.findIndex(l => /^#\s+/.test(l));
  if (startIdx < 0) return readme;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+Documentation\b/i.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim();
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderLanding(introMarkdown: string): string {
  // The intro is rendered client-side by marked.js (loaded from CDN) so we
  // don't need to add a markdown dependency just for the landing page.
  const escaped = htmlEscape(introMarkdown);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${SITE_TITLE}</title>
<link rel="icon" href="data:," />
<style>
  :root {
    --fg: #1f2328;
    --fg-muted: #59636e;
    --bg: #ffffff;
    --bg-muted: #f6f8fa;
    --border: #d1d9e0;
    --accent: #0969da;
    --accent-hover: #0550ae;
    --code-bg: #f6f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e6edf3;
      --fg-muted: #9198a1;
      --bg: #0d1117;
      --bg-muted: #161b22;
      --border: #30363d;
      --accent: #4493f8;
      --accent-hover: #79c0ff;
      --code-bg: #161b22;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans",
      Helvetica, Arial, sans-serif;
    color: var(--fg);
    background: var(--bg);
    line-height: 1.55;
  }
  header {
    background: var(--bg-muted);
    border-bottom: 1px solid var(--border);
    padding: 2.5rem 1.25rem 2rem;
  }
  header .wrap {
    max-width: 920px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: baseline;
    justify-content: space-between;
  }
  header h1 {
    margin: 0;
    font-size: 2rem;
    letter-spacing: -0.01em;
  }
  header p.tagline {
    margin: 0.25rem 0 0;
    color: var(--fg-muted);
  }
  nav.cta {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  nav.cta a {
    display: inline-flex;
    align-items: center;
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
    transition: border-color 120ms;
  }
  nav.cta a:hover { border-color: var(--accent); }
  nav.cta a.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  nav.cta a.primary:hover { background: var(--accent-hover); }
  main {
    max-width: 920px;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
  }
  main h1 { display: none; } /* duplicate of header h1 */
  main h2 {
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.3em;
    margin-top: 2rem;
  }
  a { color: var(--accent); }
  a:hover { color: var(--accent-hover); }
  pre, code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas,
      "Liberation Mono", Menlo, monospace;
    font-size: 0.9em;
  }
  code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
  pre {
    background: var(--code-bg);
    padding: 1rem;
    border-radius: 6px;
    overflow-x: auto;
  }
  pre code { background: transparent; padding: 0; }
  ul, ol { padding-left: 1.5em; }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin: 0 0 2.5rem;
  }
  .card {
    display: block;
    padding: 1.25rem 1.25rem 1.1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-muted);
    color: var(--fg);
    text-decoration: none;
    transition: border-color 120ms, transform 120ms;
  }
  .card:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }
  .card .title {
    margin: 0 0 0.25rem;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--accent);
  }
  .card .title::after {
    content: " →";
    color: var(--fg-muted);
  }
  .card p {
    margin: 0;
    font-size: 0.9rem;
    color: var(--fg-muted);
  }
  footer {
    border-top: 1px solid var(--border);
    color: var(--fg-muted);
    font-size: 0.85rem;
    text-align: center;
    padding: 1.5rem 1rem;
  }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div>
      <h1>${SITE_TITLE}</h1>
      <p class="tagline">RESTful LDAP management with a plugin-based architecture.</p>
    </div>
    <nav class="cta">
      <a class="primary" href="./api/">API reference</a>
      <a href="${REPO_URL}">GitHub repository</a>
      <a href="${REPO_URL}#documentation">Documentation</a>
    </nav>
  </div>
</header>
<main>
  <section class="cards" aria-label="Quick links">
    <a class="card" href="./api/">
      <p class="title">API reference</p>
      <p>Browse every REST endpoint with Redoc — searchable, request/response schemas, no setup.</p>
    </a>
    <a class="card" href="${REPO_URL}#documentation">
      <p class="title">Documentation</p>
      <p>Usage guides, configuration, plugin development and authentication setup on GitHub.</p>
    </a>
    <a class="card" href="${REPO_URL}">
      <p class="title">Source code</p>
      <p>linagora/ldap-rest — issues, releases, and contribution guide.</p>
    </a>
  </section>
  <article id="intro"><p>Loading…</p></article>
</main>
<footer>
  <a href="${REPO_URL}">linagora/ldap-rest</a> · Generated from
  <code>README.md</code> at build time.
</footer>
<script id="intro-source" type="text/markdown">
${escaped}
</script>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script>
  (function () {
    var src = document.getElementById('intro-source').textContent;
    document.getElementById('intro').innerHTML = window.marked.parse(src);
  })();
</script>
</body>
</html>
`;
}

function renderApiPage(): string {
  // Redoc renders the OpenAPI spec into a single static HTML page. No
  // backend needed. The spec lives one level up so we can keep
  // /openapi.json as a stable canonical URL.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${SITE_TITLE} — API reference</title>
<link rel="icon" href="data:," />
<style>
  body { margin: 0; padding: 0; }
  .topbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem 1rem;
    background: #1f2328;
    color: #fff;
    font: 500 0.9rem -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    border-bottom: 1px solid #30363d;
  }
  .topbar a { color: #9fc5ff; text-decoration: none; }
  .topbar a:hover { text-decoration: underline; }
  .topbar .sep { color: #59636e; }
</style>
</head>
<body>
<div class="topbar">
  <a href="../">← ${SITE_TITLE}</a>
  <span class="sep">·</span>
  <span>API reference</span>
  <span class="sep">·</span>
  <a href="../openapi.json">openapi.json</a>
  <span class="sep">·</span>
  <a href="${REPO_URL}">GitHub</a>
</div>
<redoc spec-url="../openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script>
</body>
</html>
`;
}

function main(): void {
  const openapiPath = path.join(root, 'openapi.json');
  if (!fs.existsSync(openapiPath)) {
    throw new Error(
      'openapi.json not found — run `npm run generate:openapi` first.'
    );
  }

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
  const intro = extractReadmeIntro(readme);

  rmrf(out);
  fs.mkdirSync(path.join(out, 'api'), { recursive: true });

  fs.copyFileSync(openapiPath, path.join(out, 'openapi.json'));
  fs.writeFileSync(path.join(out, 'index.html'), renderLanding(intro), 'utf-8');
  fs.writeFileSync(
    path.join(out, 'api', 'index.html'),
    renderApiPage(),
    'utf-8'
  );
  // GitHub Pages with Jekyll would otherwise ignore files starting with
  // an underscore. We don't have any here, but the marker is cheap and
  // future-proofs the directory.
  fs.writeFileSync(path.join(out, '.nojekyll'), '', 'utf-8');

  console.log(`✅ Site built at ${out}`);
  console.log(`   - index.html (landing, intro from README.md)`);
  console.log(`   - api/index.html (Redoc → ../openapi.json)`);
  console.log(`   - openapi.json`);
}

main();
