# Browser interface preview

This is a local, interactive design build inside the existing desktop frontend.
It reuses `src/AnswerMarkdown.tsx`, `src/codeWorkspaceState.ts` (the existing
jsdiff integration), HeroUI controls, and the user's installed CollectUI Pro
`Resizable` / `ChatConversation` components. No remote API, WebSocket, microphone,
screen capture, private context, or model calls run in this entry point.

```powershell
cd D:\Projects\Interview\apps\desktop
npm.cmd run build:browser-preview
npm.cmd run preview:browser
```

Open `http://127.0.0.1:4175/browser-preview.html`. The standard production build
and Electron entry remain unchanged; the preview builds into the separately
ignored `dist-browser-preview` directory.

Pro is pinned to the existing CollectUI package version `1.0.0-beta.8`. The
prebuild checks real component and CSS artifacts, not just the npm placeholder.
If artifacts are absent it reuses the existing sibling Connection project's
local installation. `HEROUI_PRO_LOCAL_DIR` can specify another existing package
directory. The script never changes that source project or reads license keys.
Do not replace this local distribution with an official HeroUI account login.

The preview starts at step 2 of an OOD problem. Development-only URL parameters
`?scenario=algorithm` and `?scenario=conversation` load the other fixtures. No
scenario controls, stage labels, per-answer menus or preview badges appear in the
product interface. The status truthfully says disconnected. Screenshot, analysis
and correction actions explain that the session transport is unavailable instead
of pretending to contact a model or capture a screen. Opting into `?interactive=1`
enables local fixture capture/streaming for UI verification only. Whole-plan generation is not connected to
the current server's single-proposal protocol. A copied code preview is not
observed actual code, and no example code is executed by the product.

File selection and step membership are independent. Selected tabs have a neutral
surface; every file changed by the current global step has a green dot plus the
text “本步”. Nonaffected files remain browsable. Page navigation never marks work
as completed or changes any actual-file revision.

The interface leaves instructional copy out of the reading surfaces. Primary
actions sit within the conversation pane, without page-wide header/footer bars.
Switch problem is next to analyze/update. The More menu contains add context,
pause/resume and day/night appearance. Answers remain in the continuous stream;
there is no duplicate history dialog. End interview stays at the top. Device
information has one entry through connection status. HeroUI owns control styling,
including tabs, chips, menus, typography and toast feedback;
the preview stylesheet handles layout, typography and semantic diff content only.
Icon controls retain accessible names/tooltips.

The preview starts in HeroUI's light theme and uses its native useTheme controller
for switching and persisting the appearance choice. It imports a minimal native
stylesheet instead of the production entry's hard-coded dark overrides. No interview
content is persisted in browser storage and theme changes do not restart the view.
