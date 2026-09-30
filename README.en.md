# dsh-boot-animation

A **boot animation** for DSH: when you open a new conversation — or a conversation
you pinned — a video plays full-frame in the app window.

> 中文: [README.md](README.md)

- Plays **once per new conversation** by default
- **Or every time** you open a conversation you pinned (one click in the sidebar footer)
- Fills the whole window, skippable, closes itself when it ends
- **Bring your own video** (three ways, below)

## Install

```sh
dsh plugin --profile web add github:NativeDog1/dsh-boot-animation
```

> The built output (`lib/`) is committed and the package has no `prepare`
> lifecycle script, so this installs **without compiling anything** and without
> tripping pnpm's `allowBuilds` build-approval prompt.
> (Once the package is on npm, `dsh plugin --profile web add dsh-boot-animation` works too.)

### Supported DSH versions

| DSH line | Status |
|---|---|
| `0.1.5-rc.x` / `0.1.7-rc.x` | ✅ supported (the desktop app's older core, and the `npm i -g @deepseek-ai/dsh` line) |
| `0.2.0-rc.x` | ✅ supported (the desktop app's newer core, and the `@next` line) |

**This plugin deliberately declares no `@deepseek-ai/dsh-*` `peerDependencies`.**
The host half uses only `ctx.webServer`; the browser half reaches `slots` /
`uiSession` through **dynamic injection**. Nothing statically depends on a host
package, and the direct benefit is that DSH's version gate **can never skip it** —
from 0.2.0 that gate drops a plugin whose `peerDependencies` do not match, and the
symptom is silence: installed, restarted, nothing happens, no error (the market's
own compatibility guard refuses it too). Other plugins need a `^0.1.5-rc.3 ||
^0.2.0-rc.1`-style list to cover both lines; this one does not, and cannot be
skipped for forgetting a line.

The price is tolerating host shape changes ourselves, which the tests guard:
`verify-blank` (13 host shapes), `verify-session-id`, `verify-client-boot`
(11 boot-safety checks). "Is this a brand new conversation", for example, moved in
0.2.0 from `blankBit` on the binding to `session.getSnapshot().blank` — both are
read, and the face is **subscribed to** rather than sampled once.

Then **restart the DSH service once** — bundle layers are assembled at boot:

```sh
# stop the running `dsh web`, then
dsh web
```

### Nothing happens after installing? Do this first

DSH serves client bundles with `cache-control: max-age=31536000, immutable`, and
the `rev` in the URL is a **per-process nonce** that does not change with content.
Your browser therefore keeps the first copy it ever fetched.

Press **Ctrl+Shift+R** (hard reload) in the app window. A plain F5 is not enough.

## Usage

**New conversations** play it automatically, once each.

**Pin a conversation** to replay it on *every* open:

1. Open that conversation
2. Click the **🎞** icon at the sidebar foot (next to Settings)
3. It turns green **🎬** — pinned

Every later entry into that conversation replays the animation, including after
switching away and back, or reloading. Click again to unpin.

> If at startup your active main panel is not the conversation (e.g. some plugin's
> panel is showing), there is no current conversation yet and the pin is disabled.
> Open a conversation first.

### Pin ONE conversation to ONE clip (0.4.0)

The 🎞 pin above decides **when** the animation plays. To decide **which clip a
given conversation plays**, use **「仅本会话」** (*this conversation only*) in the picker:

1. Open that conversation
2. Click **🎛** at the sidebar foot to open the clip library
3. Click **「仅本会话」** on the row you want

That row turns blue and gains a 「本会话」 badge; the top of the panel names the clip
this conversation is fixed to and offers 「取消（回到全局）」 next to it. Only that
conversation plays it — every other conversation, and the global choice you made
elsewhere, are untouched. 「选它」 changes the **global** choice; 「仅本会话」 changes
**this one conversation**. Neither overwrites the other.

Priority: **conversation override → random → global selection → env → `intro.mp4` →
`videos/` → embedded built-ins**. A conversation pin outranks random playback —
pinning a conversation and then being handed a random clip is not what pinning
means — but an explicit `mode=random` request is never overridden.

> If the clip a conversation points at is deleted or moved, that conversation **falls
> back to the global choice** instead of going black, and records
> `conversation-override-stale`; when the file comes back the pin applies again
> (one absence never deletes it).

## Built-in clips and your own video

The plugin is a **library**, not a single slot: it lists every clip it can find,
you pick one, and the choice is remembered.

**Four clips ship with it**, embedded in the code (`lib/clips.data.js`, base64 —
there are no mp4 files on disk for them):

| Name in the picker | Size |
|---|---|
| `DeepSeek 品牌片头` (brand) | 1.2 MB |
| `DeepSeek 赛博朋克片头` (cyberpunk) | 1.8 MB |
| `DeepSeek 数字角色苏醒` (awakening) | 2.5 MB |
| `DeepSeek 启动问题` (startup) | 3.2 MB |

All four are **faststart** remuxes (`moov` before `mdat`), so they play while
still downloading; the embed script refuses any input where it is not.
`media/*.mp4` is only the input to `npm run embed-clips` and is **not published**.

**Your own files still win.** The host re-resolves on every request, so swapping a
file needs no restart:

| Order | Location |
|---|---|
| 1 | the clip picked in the 🎛 library panel (`~/.dsh/boot-animation/selection.json`) |
| 2 | the file named by `DSH_BOOT_ANIMATION` |
| 3 | `~/.dsh/boot-animation/intro.mp4` |
| 4 | the newest file in `~/.dsh/boot-animation/videos/` |
| 5 | the four embedded clips above |

```sh
mkdir -p ~/.dsh/boot-animation/videos
cp my-intro.mp4 ~/.dsh/boot-animation/videos/
```

Then open the **🎛** button at the sidebar foot (next to the 🎞 pin) to pick it.

Check what is in use:

```sh
curl http://127.0.0.1:3080/dsh-boot-animation/status.json
```

## Two browser policies you cannot avoid

Autoplay **with audio** and the **Fullscreen API** both require a user gesture.
So the animation starts **muted** inside a fixed full-frame overlay (already
visually fullscreen), and **one click** unmutes it *and* enters real fullscreen.
If even muted autoplay is refused, a "click to play" state is shown instead of a
black screen.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing appears at all | Almost always the cache: **Ctrl+Shift+R**, or restart DSH |
| New conversation does not play | That conversation already played it (once per conversation). Pin it to replay every time |
| Pinned but still nothing | Check the pin is green, and that you opened the pinned conversation |
| Black screen | Open `/dsh-boot-animation/status.json` to see whether a source was found; check the console for a decode error |
| One conversation plays the wrong clip | That conversation may carry a 「仅本会话」 pin: open the picker and press 「取消（回到全局）」 at the top |
| A conversation's pinned clip vanished | The clip it named was moved or deleted — that conversation fell back to the global choice; `status.json` shows `conversation-override-stale` |
| Want to see the decisions | Set `DEBUG = true` at the top of `src/client/index.ts`, rebuild, watch the console |

## Implementation notes

- Seats: `shell.overlay` (frame-wide floating layer, `kind: list`, additive) and
  `sidebar.footer.action` (the pin)
- The current conversation comes from `ctx.uiSession.adapter.current`, a
  React-friendly store whose snapshot is the **resolved descriptor output**
  `{ key, hooks, keyedHooks, props }` — the id is at `props.sessionId` and the
  session snapshot at `hooks.session`
- "Brand new conversation" is **`blankBit`** on that snapshot (`session.blank`
  lives on another package's projected summary, not here)
- "Every open" is implemented by watching **entry into** a conversation rather
  than remembering that it played, so a pinned conversation ignores the seen list
- The video route honours **Range** requests; browsers send them for media and
  may refuse to play when a 200 arrives where a 206 was expected

## License

BSD-3-Clause, see [LICENSE](LICENSE). The clips embedded in `lib/clips.data.js`
ship under the same terms.
