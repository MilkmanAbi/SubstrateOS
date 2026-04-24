/**
 * SubstrateOS Configuration
 * The only file end-users / app devs need to touch.
 */
export default {

  // ── Identity ─────────────────────────────────────────────────────────────
  name:    'SubstrateOS',
  version: '2.0.0',
  tagline: 'Browser-native OS kernel',

  // ── Boot mode ─────────────────────────────────────────────────────────────
  //
  //   'Term'  → boots to the Substate Terminal (shell, file browser, all of it)
  //   'Apps'  → boots directly to APP_DEFAULT. The terminal is hidden.
  //             The whole site IS your app. No shell visible unless you want it.
  //
  //   From the terminal you can switch at runtime:
  //     reboot --apps   → switch to App mode
  //     reboot --term   → switch back to Terminal
  //
  BOOT: 'Term',

  // ── Default app ───────────────────────────────────────────────────────────
  //
  //   When BOOT = 'Apps', this is the app that launches.
  //   Must match a key in `apps` below.
  //   Leave empty '' to show the app selector grid instead.
  //
  //   This is how you turn a GitHub Pages site into a single app:
  //     APP_DEFAULT: 'myapp'
  //   Then https://yourusername.github.io/RepoName/ just IS myapp.
  //   Nobody sees the terminal, nobody sees other apps.
  //
  APP_DEFAULT: '',

  // ── Memory ────────────────────────────────────────────────────────────────
  memory: {
    profile:    'desktop',   // 'mobile' | 'desktop' | 'aggressive'
    // maxLimitMB: 512,       // manual limit — bypasses profile
    // pgs: false,            // platform-guaranteed-stability — removes all guardrails
  },

  // ── Lock ─────────────────────────────────────────────────────────────────
  //   'dev'    → full terminal always accessible
  //   'locked' → terminal behind password (devPassword below)
  //   'user'   → no terminal at all, App mode only
  mode: 'dev',
  devPassword: 'substrate',

  // ── Boot screen ───────────────────────────────────────────────────────────
  boot: {
    showBootScreen:  true,
    bootAnimationMs: 900,
    rcScript: [
      'echo "SubstrateOS ready."',
    ],
  },

  // ── Network ───────────────────────────────────────────────────────────────
  network: {
    enabled:   true,
    corsProxy: '',
  },

  // ── Filesystem ────────────────────────────────────────────────────────────
  fs: {
    idbName: 'substate-v2',
    defaultFiles: [
      {
        path: '/home/user/welcome.txt',
        content: `Welcome to SubstrateOS.\n\nFiles here persist across page reloads (IndexedDB).\n\nTry:\n  ls                    list files\n  cat welcome.txt       read this file\n  mkdir projects        make a directory\n  wget <url>            fetch a real URL\n  open editor           launch the text editor\n  meminfo               memory subsystem\n  reboot --apps         switch to App mode\n`,
      },
    ],
  },

  // ── Shell ─────────────────────────────────────────────────────────────────
  shell: {
    prompt:     'user@substate',
    hostname:   'substate',
    maxHistory: 500,
    aliases: {
      'll':   'ls -l',
      'la':   'ls -a',
      'cls':  'clear',
      'mem':  'meminfo',
      'vel':  'cat /proc/velocity',
      'dmu':  'cat /proc/dmu',
    },
  },

  // ── Apps ──────────────────────────────────────────────────────────────────
  //   These appear in `open <name>`, the app grid, and tab bar.
  apps: {
    editor:     { title: 'Editor',     src: './apps/editor/index.html',     icon: '✏️'  },
    imageforge: { title: 'ImageForge', src: './apps/imageforge/index.html', icon: '🖼️' },
    fetch:      { title: 'NetFetch',   src: './apps/fetch/index.html',      icon: '🌐' },
    about:      { title: 'About',      src: './apps/about/index.html',      icon: 'ℹ️'  },
  },

  // ── UI ────────────────────────────────────────────────────────────────────
  ui: {
    accent: '#f59e0b',
    theme:  'dark',
  },
};
