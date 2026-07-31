import { defineConfig } from "vitepress";
import { readFileSync } from "node:fs";

// Version badge tracks the published package automatically — read it from the root
// package.json at build time so it never goes stale on a release (the docs deploy is
// triggered on a package.json change; see .github/workflows/docs.yml).
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);

// One sidebar shape for the whole site, reused under every path prefix so a page in
// any section can reach every other section (and so a new page is added in one place).
const guideItems = [
  { text: "Get Started", link: "/guides/get-started" },
  { text: "Install", link: "/guides/install" },
  { text: "Quickstart", link: "/guides/quickstart" },
  { text: "Harness support", link: "/guides/harnesses" },
  { text: "Codex", link: "/guides/codex" },
  { text: "Kimi", link: "/guides/kimi" },
  { text: "Cowork", link: "/guides/cowork" },
  { text: "ChatGPT Work", link: "/guides/chatgpt-work" },
  { text: "Security", link: "/guides/security" },
  { text: "Troubleshooting", link: "/guides/troubleshooting" },
];

const referenceItems = [
  { text: "Concepts", link: "/reference/concepts" },
  { text: "The ten modes", link: "/reference/modes" },
  { text: "CLI commands", link: "/reference/commands" },
  { text: "Configuration", link: "/reference/configuration" },
  { text: "Pipelines", link: "/reference/pipelines" },
  { text: "Architecture", link: "/reference/architecture" },
];

const aboutItems = [{ text: "Credits", link: "/about/credits" }];

const sidebarGroups = [
  { text: "Guide", items: guideItems },
  { text: "Reference", items: referenceItems },
  { text: "About", items: aboutItems },
];

// Project Pages live under https://<owner>.github.io/muster/, so the base path
// must be "/muster/". If you later point a custom domain at the site (a CNAME),
// change base to "/" and add a website/public/CNAME file.
export default defineConfig({
  title: "Muster",
  description:
    "Glass-box agentic orchestrator for Claude Code, Codex, Kimi, and Cowork. Give it an outcome; it assembles the right crew and shows its reasoning before it acts.",
  lang: "en-US",
  base: "/muster/",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: "https://adnova-group.github.io/muster/",
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/muster/brand/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#6d5ce7" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Muster" }],
    ["meta", { property: "og:site_name", content: "Muster" }],
    ["meta", { property: "og:url", content: "https://adnova-group.github.io/muster/" }],
    ["meta", { property: "og:image", content: "https://adnova-group.github.io/muster/brand/social-preview.png" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: "Muster glass-box orchestration paths" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "Muster" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Glass-box agentic orchestrator for Claude Code, Codex, Kimi, and Cowork. Give it an outcome; it assembles the right crew and shows its reasoning before it acts.",
      },
    ],
    ["meta", { name: "twitter:description", content: "Glass-box agentic orchestrator across agent harnesses." }],
    ["meta", { name: "twitter:image", content: "https://adnova-group.github.io/muster/brand/social-preview.png" }],
    ["meta", { name: "twitter:image:alt", content: "Muster glass-box orchestration paths" }],
  ],
  themeConfig: {
    logo: {
      src: "/brand/muster-mark.svg",
      alt: "Muster home",
      width: 30,
      height: 30,
    },
    nav: [
      { text: "Guide", activeMatch: "/guides/", items: guideItems },
      {
        text: "Reference",
        activeMatch: "/reference/",
        items: referenceItems,
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
      "/guides/": sidebarGroups,
      "/reference/": sidebarGroups,
      "/about/": sidebarGroups,
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
