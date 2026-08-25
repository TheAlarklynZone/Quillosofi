<div align="center">

<img src="build/icon.svg" alt="Quillosofi" width="128" />

# Quillosofi

### Your Writing & Worldbuilding Companion — Canvas, Sheets, & A Quillibrary Actually Sticks.

`Native Desktop App` · `Privacy First` · `Chalkboard Aesthetic` · `Free & Open Source`

`This app is still in  Development! Stuff may change, break or improve over time.`

By **Alarkius Elvya Jay** · [quillosofi.com](https://www.quillosofi.com)

All Creative Control Direction (Functions & Features) is made by Me. 
Claude Code simply helps with the logic and structure.

</div>



---

Quillosofi is an all-in-one writing & thinking studio for creators — draft, organise, format, research, and reference, all in one place. A **native desktop app** (Windows `.exe`, macOS `.dmg`, Linux `.AppImage` / `.deb`) built from this single repo, with a dark-green chalkboard surface, sticky-note widgets, and a real document editor that paginates like Word.

[**Download the latest release**](https://github.com/AlarkiusJay/Quillosofi/releases/latest)

If you use windows, click the ".exe" file to download!
> If Windows SmartScreen warns you, hit **More info → Run anyway** — Quillosofi is unsigned but open source. The whole codebase is right here.
> Mac and Linux will also get a warning. Click run anyways if you want to install it. 
---

## What Quillosofi Can Do

### Canvas — a real document editor
Write, format, and save rich-text canvases as full-fledged documents.
- **Visual page-frame pagination** — pick US Letter, A4, A5, KDP trim sizes (5×8, 5.25×8, 5.5×8.5, 6×9, 7×10, 8×10), or define a custom trim. Pages render as actual sheets behind the editor.
- **Page Setup dialog** — Margins, Paper, and Layout tabs. Mirrored margins, gutter, custom inches/cm.
- **View modes** — Vertical scroll, Side-to-Side spreads, One Page, or Multiple Pages. Mouse-wheel flips spreads in book view.
- **Word-style toolbar** — font size, alignment, line spacing, indent, outline, lists.
- **Word-style ruler** — three independent indent markers (first-line, hanging, left), draggable tab stops, real Left-Tab glyph, right-indent triangle.
- **Tab key actually indents** — proper DOM capture, no keyboard race conditions.
- **Outline rail** on the left side of Canvas for jumping around long documents.
- **Multi-doc tabs** with a Canvas Editor Hub and Resume Last to pick up where you stopped.
- **Export** to TXT, MD, DOCX, or PDF.

### Sheets — live spreadsheets in your workflow
- Build conditional formatting and typed cells.
- Same multi-doc tab + Resume Last UX as Canvas via the Sheets Editor Hub.
- Lives next to your other writing inside any Space.

### Custom Dictionary
- Build your own personal vocabulary: words, definitions, categories.
- **Pin** words to passively inject them into the writing context — perfect for character names, lore terms, made-up languages, or specialised vocabulary.

### Customization
- **Themes** with full theme propagation across the app.
- **Fonts** — Oldenburg humanist slab serif by default, Lora as a backward-compatible fallback, plus everything else you'd expect.
- **Custom Keybinds** — every shortcut is editable in Settings → Keybinds.
- Sticky **Alt-toggle** native menu bar — press once, stays open until you press Alt again.

### Privacy First
- All your data is stored **locally** on your machine.
- Encrypted, never sold, always under your control.
- Export or delete everything at any time from Settings → Data & Security.

### Auto-Updates Done Right
- `electron-updater` checks GitHub Releases and (optionally) installs in the background.
- **Post-update toast** on first launch after a silent install — tells you which version you came from and which you're on, with a "See what's new" jump straight to the Update tab.
- **Auto-install heads-up chip** in Settings so you know when updates will apply silently.
- Friendlier error messaging when CI hasn't finished publishing a release manifest yet.

### Donate, Not Upgrade
Quillosofi is **free and stays free** — no Pro tier, no subscriptions, no paywalls. Settings → Donate has a real Ko-Fi link that helps cover the [quillosofi.com](https://www.quillosofi.com) domain + Spaceship hosting renewal and buys time to keep shipping features.

---

## Local development

```bash
# 1. Install
npm install

# 2. Set Base44 env (only needed for the running app, not the build)
# Create .env.local with:
#   VITE_BASE44_APP_ID=...
#   VITE_BASE44_APP_BASE_URL=...

# 3a. Run the web app
npm run dev                # http://localhost:5173

# 3b. Run the desktop app (Vite + Electron together)
npm run electron:dev
```

## Build a desktop installer

```bash
npm run build:win      # Quillosofi-Setup-<version>.exe   in release/
npm run build:mac      # Quillosofi-<version>.dmg
npm run build:linux    # Quillosofi-<version>.AppImage  +  .deb
npm run build:all      # all three (only really works on macOS runners)
```

Output lives in `release/`.

## Auto-release via GitHub Actions

Push a tag and CI builds installers on Windows, macOS, and Linux runners
in parallel and attaches them to a GitHub Release:

```bash
npm version patch       # bumps version + makes a v* tag
git push --follow-tags
```

---

## Repo layout

```
electron/                       Electron main + preload (CommonJS)
src/                            React app (renderer)
  ├─ pages/                     Chat, Settings, Space, CanvasVault,
  │                             CanvasEditorHub, SheetsEditorHub,
  │                             QuillosofiCentre
  ├─ components/                UI + chat/spaces/vault/settings/onboarding
  │                             subdirs (incl. PostUpdateToast, DonateTab)
  ├─ lib/                       AuthContext, query-client, app-params,
  │                             useFreshlyUpdated, keybinds, aiState
  └─ utils/                     guestStorage, helpers
base44/
  ├─ entities/                  Conversation, Message, Canvas, Spreadsheet,
  │                             ProjectSpace, SpaceFile, BotConfig, CustomWord,
  │                             UserMemory, GuestUsage, User
  └─ functions/                 createCheckout, getAppVersion
build/                          App icons (icon.ico / icon.icns / icon.png /
                                tray-icon.png / icon.svg source)
public/                         Favicons + PWA manifest + service worker
.github/workflows/build.yml     CI for installers
dist/                           Vite build output (gitignored)
release/                        Electron-builder output (gitignored)
```

---

## Support the project

If Quillosofi has earned its place in your toolbox:

- [**Ko-Fi**](https://ko-fi.com/alarkiusej) — keeps quillosofi.com online and buys feature-shipping time
- [**quillosofi.com**](https://www.quillosofi.com) — the marketing site
- Star this repo — costs nothing, helps a lot

---

## License

Apache-2.0 — see `LICENSE`.

<div align="center">

Quillosofi — Built with care. Designed for you.

</div>
