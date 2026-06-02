# How to record the demo GIF for the README

Goal: 10–15 second GIF that demonstrates the loop without sound. Shown at the top of the README so a stranger landing on the repo gets it in 3 seconds.

## The shot

**Split screen, two panes side by side:**

| Left half | Right half |
|---|---|
| Claude Code in a cmux terminal tab | The Vite pilot dev server in a browser tab |

The story in 15 seconds:

1. (3s) You type a prompt to Claude: *"make the button red, larger, add a fire emoji"*.
2. (4s) Claude edits `src/App.tsx` + `src/App.css`. The right pane updates via HMR — naranja → rojo, padding bigger, 🔥 appears.
3. (3s) You type a second prompt: *"how does the button look?"*
4. (5s) Claude responds describing the button. Cursor highlights the part where it says *"the red button with 🔥 to the left of the text"* or similar — proof it saw the screenshot.

## Setup before recording

1. Close other apps that may steal cmd-shift hotkeys.
2. Make cmux fullscreen with a clean 2-pane layout.
3. Pre-warm the daemon (let it capture once so the first prompt isn't slow).
4. Open `docs/examples/vite-pilot/src/App.tsx` in Claude Code so it doesn't have to find it.
5. Type the first prompt but **don't hit enter** — start the recorder, then hit enter.

## Recorder

**Option A: QuickTime (built-in)**

```
File → New Screen Recording → select region (cmux window only)
```

Then convert to GIF:

```bash
brew install ffmpeg gifsicle
ffmpeg -i recording.mov -vf "fps=15,scale=1200:-1:flags=lanczos" -t 15 /tmp/raw.gif
gifsicle -O3 /tmp/raw.gif -o docs/assets/demo.gif
```

Target: under 4 MB so GitHub embeds it inline.

**Option B: Kap** (free, [getkap.co](https://getkap.co))

- Records as GIF/MP4 natively
- 1200×720, 15 fps, 4 MB cap

**Option C: LICEcap** (free, [cockos.com/licecap](https://www.cockos.com/licecap/))

- Smallest output
- 1200×720, 15 fps

## What to keep / cut

- ✅ Keep: the moment Claude's response **mentions a specific visual detail** (color, emoji position, padding feel). That's the proof of vision.
- ✂ Cut: anything more than 1 second of "Claude is thinking…" spinner. Speed it up if needed (`-vf "setpts=0.5*PTS"`).
- ✅ Keep: the visual diff appearing in `.claude/eyes/diff-NNN.png` if you can fit it (bonus credibility).
- ✂ Cut: any personal paths visible in the terminal scrollback.

## Where it goes

`docs/assets/demo.gif` — referenced from the top of `README.md` as:

```markdown
![claude-eyes demo](docs/assets/demo.gif)
```

Right under the title, before the hero quote.

## Backup angle

If GIF recording is awkward, a static 2-panel screenshot also works:

- Left: Claude Code chat showing the prompt + response that describes the UI
- Right: the dev server with the change

Same composition, less drama. Put it under `docs/assets/demo.png`.
