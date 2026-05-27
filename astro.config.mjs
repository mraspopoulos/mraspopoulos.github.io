import { defineConfig } from 'astro/config';

// User GitHub Pages site (mraspopoulos.github.io) → base is '/'
// If you ever move to a project page (github.io/repo-name), set `base: '/repo-name/'`.
export default defineConfig({
  site: 'https://mraspopoulos.github.io',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
});
