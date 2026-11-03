import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.ATEM_CROSSPOINT_API ?? 'http://localhost:8533';

/** Set by `build:sim` / `dev:sim`, the same switch App.tsx reads. */
const SIMULATOR = process.env.VITE_SIMULATOR === '1';

/**
 * The hosted demo's head, and the files a crawler asks for, for the simulator
 * build only.
 *
 * index.html is the real product's page too, served on the show network by
 * packages/server, and a canonical address or a sitemap pointing at
 * blackmatrix-demo has no business there. So the title, description, share card,
 * JSON-LD and <noscript> summary are added here, and robots.txt, sitemap.xml and
 * llms.txt come from public-demo/ rather than public/, which both builds copy.
 */
const HOST = 'https://blackmatrix-demo.stoatworks-labs.com';
const PAGE = 'https://stoatworks-labs.com/software/blackmatrix/';
const REPO = 'https://github.com/stoatworks-labs/blackmatrix';
const TITLE = 'BlackMatrix demo — An ATEM fleet as one router, with failover';
const DESCRIPTION =
  'A demo of BlackMatrix in your browser: a crosspoint router matrix over a fleet of Blackmagic ATEM switchers, driving a simulated fleet built in the tab. Free, and nothing is on a network.';
const DEMO_FILES = new URL('./public-demo/', import.meta.url);

function demoSite(): Plugin {
  const meta = (key: 'name' | 'property', name: string, content: string): HtmlTagDescriptor => ({
    tag: 'meta',
    injectTo: 'head',
    attrs: { [key]: name, content },
  });
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    '@id': `${HOST}#app`,
    name: 'BlackMatrix demo',
    url: HOST,
    description: DESCRIPTION,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any (runs in a web browser)',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' },
    author: {
      '@id': 'https://stoatworks-labs.com/#organization',
      '@type': 'Organization',
      name: 'Stoatworks Labs',
      url: 'https://stoatworks-labs.com/',
    },
    publisher: { '@id': 'https://stoatworks-labs.com/#organization' },
    sameAs: [PAGE, REPO],
  };
  const noscript = [
    '<h1>BlackMatrix demo</h1>',
    "<p>A crosspoint router matrix over a fleet of Blackmagic ATEM switchers: sources across the top, destinations down the side, one click to route. It also serves the Videohub Ethernet Protocol, one server per switcher, so hardware router panels, Companion and a media server's own matrix driver all get at the same crosspoints. On a redundant rig it watches the main media server and fires a salvo when it stops answering.</p>",
    "<p>This page is a demo of the app, and it needs JavaScript. It drives a simulated fleet you build from the device library, made up inside the tab, so nothing is on a network and nothing is being controlled. A web page can't reach a switcher at all: the ATEM protocol is UDP and the Videohub protocol is raw TCP. To route real hardware, run the app on the show network.</p>",
    `<p><a href="${PAGE}">Project page</a> · <a href="${PAGE}guide/">User guide</a> · <a href="${REPO}">Source on GitHub</a></p>`,
  ].join('');
  return {
    name: 'blackmatrix-demo-site',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return {
          html: html.replace('<title>BlackMatrix</title>', `<title>${TITLE}</title>`),
          tags: [
            meta('name', 'description', DESCRIPTION),
            { tag: 'link', injectTo: 'head', attrs: { rel: 'canonical', href: `${HOST}/` } },
            meta('property', 'og:type', 'website'),
            meta('property', 'og:site_name', 'Stoatworks Labs'),
            meta('property', 'og:title', TITLE),
            meta('property', 'og:description', DESCRIPTION),
            meta('property', 'og:url', `${HOST}/`),
            meta('property', 'og:image', 'https://stoatworks-labs.com/thumbs/blackmatrix.png'),
            meta('property', 'og:image:width', '1280'),
            meta('property', 'og:image:height', '720'),
            meta('property', 'og:image:alt', 'BlackMatrix'),
            meta('name', 'twitter:card', 'summary_large_image'),
            {
              tag: 'script',
              injectTo: 'head',
              attrs: { type: 'application/ld+json' },
              children: JSON.stringify(jsonLd),
            },
            { tag: 'noscript', injectTo: 'body-prepend', children: noscript },
          ],
        };
      },
    },
    generateBundle() {
      for (const fileName of readdirSync(DEMO_FILES)) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(fileName, DEMO_FILES)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), ...(SIMULATOR ? [demoSite()] : [])],
  server: {
    port: 5183,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
