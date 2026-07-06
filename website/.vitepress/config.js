import { defineConfig } from "vitepress";
import { readFileSync } from "node:fs";

// Version badge tracks the published package automatically — read it from the root
// package.json at build time so it never goes stale on a release (the docs deploy is
// triggered on a package.json change; see .github/workflows/docs.yml).
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);

// Project Pages live under https://<owner>.github.io/muster/, so the base path
// must be "/muster/". If you later point a custom domain at the site (a CNAME),
// change base to "/" and add a website/public/CNAME file.
export default defineConfig({
  title: "Muster",
  description:
    "Glass-box agentic orchestrator for Claude Code. Give it an outcome; it assembles the right crew and shows its reasoning before it acts.",
  lang: "en-US",
  base: "/muster/",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#6d5ce7" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Muster" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Glass-box agentic orchestrator for Claude Code. Give it an outcome; it assembles the right crew and shows its reasoning before it acts.",
      },
    ],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guides/install", activeMatch: "/guides/" },
      {
        text: "Reference",
        link: "/reference/concepts",
        activeMatch: "/reference/",
      },
      { text: "Credits", link: "/about/credits" },
      {
        text: `v${version}`,
        items: [
          {
            text: "Changelog",
            link: "https://github.com/Adnova-Group/muster/blob/main/CHANGELOG.md",
          },
          {
            text: "npm",
            link: "https://www.npmjs.com/package/@adnova-group/muster",
          },
        ],
      },
    ],
    sidebar: {
      "/guides/": [
        {
          text: "Guide",
          items: [
            { text: "Install", link: "/guides/install" },
            { text: "Quickstart", link: "/guides/quickstart" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Concepts", link: "/reference/concepts" },
            { text: "The six modes", link: "/reference/modes" },
            { text: "CLI commands", link: "/reference/commands" },
            { text: "Pipelines", link: "/reference/pipelines" },
            { text: "Architecture", link: "/reference/architecture" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Guide",
          items: [
            { text: "Install", link: "/guides/install" },
            { text: "Quickstart", link: "/guides/quickstart" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Concepts", link: "/reference/concepts" },
            { text: "The six modes", link: "/reference/modes" },
            { text: "CLI commands", link: "/reference/commands" },
            { text: "Pipelines", link: "/reference/pipelines" },
            { text: "Architecture", link: "/reference/architecture" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/Adnova-Group/muster" },
    ],
    search: { provider: "local" },
    editLink: {
      pattern:
        "https://github.com/Adnova-Group/muster/edit/main/website/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the Apache-2.0 License.",
      copyright: "Copyright © 2026 Adnova Group",
    },
  },
});
