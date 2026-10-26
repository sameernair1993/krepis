import { slug } from 'github-slugger';
import { defineConfig } from 'vitepress';

const repo = 'https://github.com/sameernair1993/krepis';
// Served from https://<user>.github.io/krepis/. Change to '/' for a custom domain.
const base = '/krepis/';

export default defineConfig({
  title: 'Krepis',
  description: 'A typed data layer for MongoDB on Node.js, with safe defaults and an analyser for N+1 queries. Alpha.',
  base,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#0f766e' }],
    ['meta', { property: 'og:title', content: 'Krepis' }],
    ['meta', { property: 'og:description', content: 'A typed data layer for MongoDB on Node.js. Alpha.' }],
  ],
  // Private notes may sit in docs/ locally; never publish them.
  srcExclude: ['DECISIONS.md', 'ROADMAP.md', '**/*.private.md'],
  markdown: {
    // GitHub's heading anchors, so `FILE.md#heading` links work on GitHub and on the site alike.
    anchor: { slugify: slug },
  },
  themeConfig: {
    logo: { src: '/logo.svg', alt: '' },
    nav: [
      { text: 'Guide', link: '/GUIDE' },
      { text: 'API', link: '/API' },
      { text: 'Connections', link: '/CONNECTIONS' },
      { text: 'Rules', link: '/RULES' },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Guide', link: '/GUIDE' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API', link: '/API' },
          { text: 'Connections', link: '/CONNECTIONS' },
          { text: 'Rules', link: '/RULES' },
          { text: 'Architecture', link: '/ARCHITECTURE' },
        ],
      },
      {
        text: 'Security and privacy',
        items: [
          { text: 'Security', link: '/SECURITY' },
          { text: 'Privacy', link: '/PRIVACY' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    editLink: { pattern: `${repo}/edit/main/docs/:path` },
    outline: [2, 3],
    footer: {
      message: 'Released under the MIT License. An independent project, not affiliated with MongoDB, Inc.',
    },
  },
});
