# Lungo

Cloud machines for your Claude Code sessions. (It was called Skybuild; the CLI is still `sky`.)

`sky` creates a VM with a persistent volume and sets it up with the tools you use. It keeps your
Claude Code setup and logins, GitHub, API keys and CLI credentials in sync on it, and puts every
machine one `ssh <name>` away. Sessions run in tmux, so closing your laptop doesn't stop Claude.
The **Lungo** desktop app does the same through a window, and adds terminal tabs that attach
to those sessions.

```
$ sky new api-box
✓ Checking Compute Engine in my-gcp-project           9s
✓ VM created at 34.123.45.67                          18s
✓ Machine set up                                      3m12s
✓ On the tailnet as api-box.your-tailnet.ts.net
✓ api-box is ready. Connect with: ssh api-box

$ sky claude api-box ~/code/api -p "fix the failing tests" -d
● Claude is running in claude-api on api-box

$ sky sessions
  MACHINE   SESSION      STATE         DIR          ACTIVE
  api-box   claude-api   ◉ needs you   ~/code/api   just now
```

## Install

```sh
make install            # sky → ~/.local/bin
make desktop-install    # Lungo.app → ~/Applications (needs Wails: go install github.com/wailsapp/wails/v2/cmd/wails@latest)
sky doctor              # checks ssh, Tailscale, cloud logins, Claude, gh
```

Prebuilt binaries for macOS, Linux and Windows come from `make cli-all` or the release workflow.

## Where machines come from

| Provider | Uses | Account means |
| --- | --- | --- |
| Google Cloud (default) | `gcloud` | a project |
| AWS | `aws` | a profile |
| Azure | `az` | a subscription |
| Your own box | plain SSH | `sky add name user@host` or `--alias` from `~/.ssh/config` |

Connecting a cloud means signing in to its CLI once (`sky login gcp`), so sky uses the same login
you already have. No keys are pasted into sky.

## What a machine is

- **The VM:** Ubuntu 24.04 with a 30 GB boot disk.
- **The volume:** a separate persistent disk mounted at `/home`. Your repos, tools, tmux, Claude
  history and logins all live on it. It survives stopping the VM. Use `sky rm <name> --keep-disk`
  to delete the VM and keep the volume; `sky new <name>` later brings the same home back.
  `sky disk <name> 300` grows it.
- **The setup:** git, tmux, zsh, Node 24, Bun, uv, Docker, gh, ripgrep, build tools, Claude Code,
  and a 4 GB swapfile. SSH logins land in a tmux session (`SKY_NO_TMUX=1` or `sky ssh --no-tmux`
  skips it).
- **Tailscale (optional):** the machine joins your tailnet and gets a stable `100.x` address.
  `sky tailscale key` saves an auth key so this happens without the approve-in-browser step.
- **`ssh <name>`:** sky writes `~/.skybuild/ssh_config` and includes it from `~/.ssh/config`. That
  also works in VS Code Remote-SSH, scp, rsync and any terminal. `sky ssh` prints the full
  standalone command too.

Stopped machines only bill for storage (`sky stop`). tmux sessions end when a machine stops,
but everything on the volume stays.

**Quotas:** new GCP projects often cap SSD storage at 250 GB per region. `sky new` checks the
quota first and says which limit is in the way. Pick another region with `--region`, or raise the
limit in the console.

**Tailscale in userspace mode:** if this computer runs tailscaled with
`--tun=userspace-networking`, macOS has no route to 100.x addresses. sky notices and connects
through `tailscale nc`, both in `~/.ssh/config` and for its own connections.

**A machine that already syncs another way:** `sky add mini --alias macmini` works, but turn off
the other sync first (for example claude-sync-mini). Two tools writing the same token files every
minute will fight over them.

## Sync

This computer is the source of truth. `sky sync` pushes, and nothing comes back.

| Item | What |
| --- | --- |
| `claude` | Claude Code version (pinned), settings.json, skills, agents, commands, output styles, CLAUDE.md, keybindings, MCP servers (except ones pointing at localhost), plugins |
| `claude-login` | A long-lived `claude setup-token` token for your account, kept in your keychain and written to `~/.claude/.oauth-token` on machines |
| `github` | Every working `gh` account and the active one; git push over HTTPS through gh |
| `git` | `~/.gitconfig`, with macOS keychain helpers swapped for gh |
| `env` | Secret exports from your shell startup files (`…_KEY`, `…_TOKEN`, `…_SECRET`), resolved to values, written to `~/.secrets.sh` |
| `credentials` | gcloud, AWS, Docker, npm, Modal, Fly, Railway, Vercel, Stripe, kube, Hugging Face, Supabase and more |
| `files` | Anything you add with `sky config sync-paths ~/.config/foo,~/.ssh/config` |

- Choose items per machine with `sky sync items <name>`.
- `sky sync -n` shows a dry run.
- `sky agent install` syncs in the background every 2 minutes, via launchd, systemd or Task
  Scheduler.
- Some files are never synced, by design: SSH keys, wallets, and tools whose refresh tokens rotate
  (Codex, Factory, Grok, Wrangler), because sharing those signs one machine out.

Sync gives machines your credentials, so treat every machine as you'd treat your laptop.

## Claude accounts

Add every Claude subscription you have (`sky accounts claude add`, or Accounts → Add account).
Each gets a long-lived token in your keychain.

- **Usage:** sky reads each account's 5-hour and weekly usage through a tiny Claude Code request
  (these tokens can't read Anthropic's usage API, but Claude Code reports rate limits itself).
- **Names:** a token can't say whose it is. When this computer's Claude Code is signed in to the
  same account, sky matches the two by their usage windows and fills in the email and plan.
- **Smart order (default):** unused weekly allowance disappears at each account's reset, so
  machines use whichever account has the most allowance about to expire, and save the ones whose
  reset is far away. An account at its 5-hour or weekly limit is skipped until it resets.
  `sky accounts claude strategy order` uses your list order instead.
- **Auto-switch:** when the account in use hits a limit (or a better one frees up), machines get
  the new token and sessions stuck on a limit prompt restart with `claude --resume` on the new
  account. With auto-switch off, sky only suggests the move.

The desktop app checks every minute and the background agent every two.

## API keys

`sky keys add OPENAI_API_KEY` (or the Keys page) stores a key in your keychain and sets it on
machines as an environment variable. Keys exported in your shell startup files are picked up too.
`sky keys test` checks a key against its own service; `sky keys machines NAME box,lab` limits
where it goes. `sky keys services` lists the services sky knows.

## Desktop app

- **Sessions:** terminal tabs attached to tmux sessions on your machines and on this computer.
  `⌘T` opens a tab like the focused pane (same machine, same folder, Claude if it runs
  Claude); `⌘D` / `⇧⌘D` split it with a shell in the same folder (a Claude split is in the
  pane's menu). `⌥⌘←→↑↓` moves between panes, `⇧⌘↩` zooms one, `⌘W` closes one,
  `⌘J` jumps to the next session that needs you, `⌘K` searches everything.
- **Under each pane:** the folder it is in and, in a repository, the branch with how many
  files changed. Click the folder to copy its path or open a terminal or Claude there; click
  the branch to continue the repository on a machine, or bring it back, as it is (branch,
  commits and uncommitted work).
- **Tabs:** right-click a tab (or a session in the sidebar) to give it your own name and a
  colour, pin it as an icon, or file it under a **workspace**: a named set of tabs, picked
  from the button left of the tabs or with `⇧⌘1`–`⇧⌘9` (`⇧⌘0` shows every tab). Tabs opened
  in a workspace belong to it. The brush on a machine ends sessions Claude has left.
- **Putting sessions together:** ⌘-click (or ⇧-click for a range) sessions in the sidebar
  and press "Open together" for one tab with them side by side; drag a session onto a pane to
  put it on that side; right-click a tab, "Combine with…" to merge two tabs. Panes that were
  already open move without reconnecting.
- **History** (`⌘Y`) lists past Claude conversations on every machine and here; Enter
  resumes one. **Search everything** (`⇧⌘F`) looks through what open sessions show and past
  conversations. Also `sky history`, `sky resume`, `sky search`.
- **Recipes** (`⇧⌘R`, or by name in `⌘K`): sessions you start often. A machine, a folder,
  and Claude with a first message or a shell with a command. `{clipboard}` and `{ask}` in the
  message are filled in when it runs.
- **Prompt composer** (`⌘E`): write to the session in front in a real editor. `@` mentions a
  file from its folder, snippets and what you sent before are a click away, `⌘↩` sends it,
  `⌥↩` only puts it in the session's input.
- **Ports:** when something in a pane starts listening (a dev server), its port shows under
  the pane. A click opens it in the browser, through a tunnel when it is on a machine.
- **Switching:** hold `⌃` (or `⌥`) and tap `Tab` for a grid of live previews of every tab, most
  recent first; a quick tap flips between the last two. Arrows move around the grid and typing
  narrows it down.
- **Home:** the start screen (start a session, the sessions to pick up, the shortcuts), first in the icon row.
- **Machines, Sync, Projects, Accounts (with API keys), Settings:** the same things the CLI does. Themes,
  text size (`⌘+` / `⌘-`) and the collapsible sidebar (`⌘B`) are in Settings and the View menu.

### Picking up where you left off

Every pane is a tmux session, so nothing you had open depends on the app or on a connection:

- **Quit or restart the app:** every tab and split comes back attached to its session, the
  ones in background tabs too: each pane shows its last screen the moment the window opens and
  the live one takes over as it attaches (all of them within about a second and a half), and
  the sidebar lists the sessions straight away. Sessions on this computer run in a tmux server of sky's own
  (socket `skybuild`, apart from any tmux you use), so they keep running as well. Without tmux
  on this computer local panes are plain shells that end with the app; Settings offers to
  install it.
- **Sleep, or a network change:** connections that died are replaced when the computer wakes.
  The pane keeps showing what it showed and attaches again by itself; while a machine can't be
  reached it keeps trying and says why.
- **A machine or this computer restarts:** tmux is gone and so are its sessions. Panes make
  them again in the folder they were in, and a pane that was running Claude resumes its
  conversation (`claude --resume <id>`, with the permission flags it was started with).
- **A session you ended** (you left its shell, or killed it) is not made again: its pane closes.

- **The machines switch Claude accounts:** Claude reads its login when it starts, so each
  session still on the previous login (marked "old login" in the sidebar) is restarted with
  its conversation the moment it is idle or stuck on the old account's limit; never while it
  works or while you type. "Move sessions" on the Accounts page turns that off.

Copying inside a session (a drag in tmux, a yank in vim) reaches your clipboard. "Open
Lungo when I log in" is in Settings, and so is the app icon.

### Files on a machine, seen from here

A session's files are where its machine is: the video Claude rendered on the Mac mini is on
the Mac mini. Three ways to look at one without leaving your chair:

- **⌘-click a file name in a session.** A path (`~/out/a.png`, `src/app.ts`) or just a name
  (`Creed-promo.mp4`): the app finds it on that machine (the session's folder, then the
  Desktop, Downloads, Documents and the home folder), brings it over and shows it: videos
  play, images and PDFs show, text reads. From there: open it in its own app, keep it in
  Downloads, show it in Finder, copy its path.
- **Files** (`⌘O`, or the chip at the bottom right of a pane) lists what was made or changed
  lately where the session works and on that machine's Desktop and in its Downloads, newest
  first. "Browse" walks the machine's folders. `←` `→` step through the list in the preview.
- **`peek <file>`** on a machine (sync installs it, in `~/.local/bin`) shows the file on the
  screen of whoever has the session open. Claude can run it: "peek the video".

Files brought over are kept for a few days in `~/.skybuild/peek`, so a second look is instant.

### Moving a folder to another device

The Projects page opens on **where you've been working**: per device (this Mac, each
machine), the folders Claude ran in lately, newest first, each with its branch, how many
files have changed, the sessions open in it and its conversations. Hover one for Resume
(the latest conversation), a shell there, or **Send to**.

Send to copies the folder to another device as it is: every file, the git history, the
branch and work not committed yet, and the Claude conversations that ran in it (they land
where that device's Claude looks, with their paths pointed at the folder's new place, so
`claude --resume` works there). Any two devices: this Mac and a machine, or one machine to
another (it streams through this Mac). The folder goes to the same place under the other
home folder (`~/Documents/codes/krypton` stays `~/Documents/codes/krypton`). Left out:
`node_modules`, Python environments and other caches, which each device builds for itself.
The folder stays where it was too; "Pick up on …" opens Claude there in the latest
conversation.

### Working on a session together

Any session (on this Mac or a machine) can be shared with people on your tailnet, the way a
document is. One click on the people icon in a pane's title bar (or the top bar) shares it,
copies its link (`lungo://join/7KX-4PQ`) and shows its code, `7KX-4PQ`, to read out; the
panel switches between a code to type along and one to watch. They click the link, or press
`⇧⌘J` in their Lungo and type the code (or paste it in `⌘K`), and the session opens in a tab
of theirs, live:

- **The same screen:** everyone sees it at the size of your pane (theirs shrinks the font to
  fit), so a cell is the same cell for everyone.
- **Pointers, clicks and selections:** each person's pointer shows on the others' screens as
  an arrowhead in their colour, with their name while it moves; their clicks land as a ring,
  what they select shows in their colour, and whoever is typing has their name at the cursor.
  Click someone's face (on the pane, or in its panel) to see where they are.
- **Ports:** what the session listens on (a dev server) opens on each guest's own
  `localhost`, on the same number when it is free there. Only the session's ports: nothing
  else on your computer is reachable.
- **Who is in it:** their faces on the pane and on its row in the sidebar. The panel makes
  anyone watch-only or lets them type, removes them (their link stops working for them),
  or stops sharing (every link stops working, everyone is seen out).

Nothing is hosted anywhere. Your Lungo serves the session on your tailnet address only
(port 47863), Tailscale carries it and says who is on the other end, and the code decides
who gets in: their Lungo asks the computers on your tailnet which one shares it (yours
answers; a computer turns away guesses after a few wrong codes a minute). People on another
tailnet need your computer shared with them in Tailscale first. A code that lets people
type gives them your session as you: send it to the people you mean, and stop sharing to
end it.

### A machine's screen

A Mac machine's screen shows live in the app, and you can use it from there: `⇧⌘S` for the
machine of the pane in front, the Screen chip at the bottom of a pane, or the monitor button
on the machine in the sidebar. It is macOS's own Screen Sharing (which has to be on, on that
Mac), reached through the ssh connection sky already has: no port is opened to the network.
It asks once for the name and password of a user on that Mac and keeps them in your
keychain. In the bar: watch only (nothing you do reaches the Mac), fit or real size, paste
your clipboard there. Linux machines have no screen to show.

### The welcome

The first time Lungo opens, it tells what it is and how it works in a few short stories:
- **Setting up:** the agents on this Mac and their versions, your machines (add one from there), and the logins that follow you.
- **What it does:** short scenes of the sidebar and alerts, panes and the switcher, files from machines, moving a folder, and a Mac's screen. Each plays by itself.
- **Your look:** a theme and an app icon.
- **Starting:** your first session.

Enter goes on, ← goes back, Space pauses a scene, Esc skips. Help ▸ Welcome to Lungo or Settings ▸ Welcome brings it back.

## Health and stopping when idle

`sky health` (and the Machines page) shows each machine's CPU, memory and disk, and for
cloud machines what they cost. `sky idle <machine> 2h` stops a cloud machine after two hours
with nothing happening: no Claude working, no one attached, no ssh login, no load. A small
watchdog on the machine decides, so it works with the laptop closed. Opening a session on a
stopped machine starts it again; its sessions come back with their conversations.

## Commands

```
Machines        new · add · ls · start · stop · restart · resize · disk · rm · import
Working         ssh · claude · codex · grok · mantis · sessions · attach · connect · open · ports · run
Sync and files  sync · keys · push · pull · clone · link (add/ls/rm/sync/watch)
Setup           accounts (claude …) · login · tailscale · agent · config · doctor · app
```

Examples:

```sh
sky new                                  # guided: provider, project, region, size, volume
sky add mini --alias macmini             # an existing machine from ~/.ssh/config
sky push . box:~/code/app --lean         # copy a folder, skipping node_modules & build output
sky link add ~/code/site box:~/code/site --watch && sky link watch
sky clone box spawnlabs/api              # uses the synced gh login
sky open box 3000                        # localhost:3000 → box:3000, opens the browser
sky run all 'df -h /home'                # one command on every machine
sky login claude                         # token for machines (browser approval, valid a year)
```

`--json` on any command prints machine-readable output.

## Claude sessions

`sky claude <machine> [dir]` starts Claude Code in a named tmux session. Hooks report
Claude's state to `~/.skybuild/status/` on the machine:
- `working` after a prompt or tool use
- `needs you` on a notification, such as a permission request
- `idle` when Claude finishes

`sky sessions` shows that state for every machine, with the title Claude gave the session.
The desktop app shows it live, lists sessions on this computer the same way (there the state
comes from Claude Code's own record of its running sessions, so nothing is installed in your
local settings), and sends a notification when Claude needs you.

## Other coding agents

Codex, Grok Build and [Mantis](https://mantisagent.cc/) work the same way. `sky codex`,
`sky grok` and `sky mantis` take the same `<machine> [dir]` (and `-n`, `-d`; `-p` for
Codex and Grok). In the desktop app the New session dialog (⇧⌘T) has a row of agents, and an
agent that isn't installed on the machine is greyed out. A pane's menu has "Start an agent
here…".

Their sessions are found by the program running in the pane, including agents run by Python
or Node. They are listed with their own logo. Their state comes from the screen:
- `working` while the agent says "esc to interrupt" (Grok: "Esc:cancel")
- `needs you` on a choice, such as a permission prompt, Codex's folder trust or update prompt
- `idle` otherwise

You get the same notifications as for Claude.

If a session is lost, for example after a restart, its pane comes back in the same folder and
picks up the folder's latest conversation: `codex resume --last`, `grok --continue`,
`mantis --continue`. None of these agents need hooks or anything else installed on the machine.

## Layout

```
cmd/sky/              CLI (cobra + huh)
desktop/              Wails desktop app (React + xterm.js), same engine
internal/engine       everything sky does, one API for both front ends
internal/provider/    gcp · aws · azure adapters over their CLIs
internal/bootstrap    first-boot setup script (volume → /home, user, toolchain)
internal/syncer       sync items (Go port of claude-sync-mini, any number of machines)
internal/sshx         sky's key, ssh/rsync invocation, ~/.ssh/config entries
internal/tailnet      Tailscale join and status
internal/folders      push/pull via rsync, tar fallback
internal/claudeacct  Claude account usage checks and the smart ranking
internal/apikeys     API key catalogue, keychain storage and key tests
internal/term        pseudo-terminal + WebSocket bridge for desktop terminal tabs
```

State lives in `~/.skybuild/`:
- `config.json`: machines, links and settings
- `keys/`: sky's SSH key
- `known_hosts/`: host keys, one file per machine
- `state/`: sync state
- `logs/`

Secrets (the Claude token and the Tailscale key) live in the OS keychain.
