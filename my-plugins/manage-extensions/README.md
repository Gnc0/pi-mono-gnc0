# manage-extensions

Interactive extension manager for pi. Toggle extensions on/off for project (local) or global scope via symlinks.

## Usage

```text
/manage-extensions
```

The command starts extension discovery in the background. If no cached result exists yet, it now shows a live scanning screen and then automatically opens the TUI once scanning completes. The scan view shows the current repo, current entry, current repo progress, and current entry progress.

```text
→ L[✓] G[ ]  my-plugins/oh-my-pi
  L[ ] G[ ]  my-plugins/show-sys-prompt.ts
```

- **L** = local (project `.pi/extensions/`)
- **G** = global (`~/.pi/agent/extensions/`)
- **↑/↓** move between extensions
- **←/→** switch between L/G column while list is focused
- **Space** or **Enter** toggle the selected checkbox while list is focused
- **Type** to search at any time using case-insensitive ordered character matching (`g54` can match names like `gpt-5.4`)
- **Tab** moves focus to the bottom action bar
- Bottom action bar supports **Apply Changes / Back to List / Cancel**
- **Esc** no longer exits immediately: first press arms cancel and shows a warning, second press cancels and exits
- Active scope is made more obvious with stronger **L / G** color treatment and a current-column hint
- Pending row edits are marked inline so accidental toggles are easier to spot

## Configuration

Create `extension-repos.json` in `.pi/` (project) or `~/.pi/agent/` (global):

```json
[
  { "name": "my-plugins", "path": "/absolute/path/to/my-plugins" },
  { "name": "shared", "path": "/path/to/shared-extensions" }
]
```

Both files are read and merged (deduplicated by resolved path). Each repo path is scanned one level deep for valid extensions:

- `.ts` / `.js` files
- Directories with `index.ts` / `index.js`
- Directories with `package.json` containing `pi.extensions`

Extension names must be unique across all configured repos. This plugin creates links by extension name, so duplicate names are reported and must be resolved before changes can be applied.

## How it works

Activation creates a relative symlink from the target extensions dir to the source:

```text
.pi/extensions/oh-my-pi -> ../../my-plugins/oh-my-pi
```

Deactivation removes the symlink. Refuses to remove non-symlink files (shows a warning).

If scanning fails, the command shows the scan error instead of pretending no repos are configured.

After confirming changes via the inline action bar, triggers `/reload` to pick up the new extension set.
