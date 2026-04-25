/**
 * Render every fixture markdown file (except `README.md`) under
 * `fixtures/applicants/<applicant>/` to a sibling `.pdf` using `marked`
 * for HTML rendering and headless Chrome for PDF generation.
 * Re-run with `pnpm fixtures:pdf`.
 *
 * Chrome binary path resolves from `CHROME_BIN` env var, falling back to
 * the macOS default install location.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';

const ROOT = resolve(import.meta.dirname, '..');
const APPLICANTS_DIR = join(ROOT, 'fixtures/applicants');
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PRINT_CSS = `
  @page { size: Letter; margin: 0.75in; }
  html, body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #111; font-size: 11pt; line-height: 1.45; }
  body { margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 0.4em; }
  h2 { font-size: 15pt; margin: 1.2em 0 0.4em; border-bottom: 1px solid #ddd; padding-bottom: 0.15em; }
  h3 { font-size: 12pt; margin: 1em 0 0.3em; }
  p, ul, ol { margin: 0 0 0.6em; }
  ul, ol { padding-left: 1.4em; }
  li { margin: 0.15em 0; }
  table { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 10pt; }
  th, td { border: 1px solid #888; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
  pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9.5pt; background: #f5f5f5; padding: 8px 10px; border-radius: 4px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #bbb; margin: 0.6em 0; padding: 0.1em 0.8em; color: #444; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 1.2em 0; }
  a { color: #1a4cdb; text-decoration: none; }
`;

function htmlShell(title: string, body: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head><body>
${body}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

async function findMarkdownFiles(): Promise<string[]> {
  const out: string[] = [];
  const applicants = await readdir(APPLICANTS_DIR, { withFileTypes: true });
  for (const a of applicants) {
    if (!a.isDirectory()) continue;
    const dir = join(APPLICANTS_DIR, a.name);
    for (const f of await readdir(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith('.md')) continue;
      if (f.name === 'README.md') continue;
      out.push(join(dir, f.name));
    }
  }
  return out.sort();
}

function resolveChromeBin(): string {
  const envPath = process.env.CHROME_BIN;
  if (envPath) {
    if (!existsSync(envPath)) {
      throw new Error(`CHROME_BIN points to a missing file: ${envPath}`);
    }
    return envPath;
  }
  if (existsSync(DEFAULT_CHROME)) return DEFAULT_CHROME;
  throw new Error(
    `Could not find a Chrome binary. Set CHROME_BIN to the path of a Chrome / Chromium executable.`,
  );
}

function renderPdf(chromeBin: string, htmlPath: string, pdfPath: string): void {
  const result = spawnSync(
    chromeBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(`Chrome exited with status ${result.status}: ${stderr}`);
  }
}

async function main() {
  const chromeBin = resolveChromeBin();
  const files = await findMarkdownFiles();
  if (files.length === 0) {
    throw new Error(`No markdown fixture files found under ${APPLICANTS_DIR}`);
  }

  const workdir = mkdtempSync(join(tmpdir(), 'accordingly-fixture-pdf-'));
  try {
    for (const mdPath of files) {
      const md = readFileSync(mdPath, 'utf8');
      const bodyHtml = await marked.parse(md, { gfm: true, async: true });
      const title = basename(mdPath, '.md');
      const html = htmlShell(title, bodyHtml);

      const htmlPath = join(workdir, `${title}.html`);
      writeFileSync(htmlPath, html, 'utf8');

      const pdfPath = join(dirname(mdPath), `${title}.pdf`);
      renderPdf(chromeBin, htmlPath, pdfPath);
      console.log(`✓ ${mdPath.slice(ROOT.length + 1)} → ${pdfPath.slice(ROOT.length + 1)}`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
