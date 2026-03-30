# manage-extensions

Interactive extension manager for pi. Toggle extensions on/off for project (local) or global scope via symlinks.

## Usage

```
/manage-extensions
```

Opens a TUI list of all extensions discovered from configured repos. Each row shows:

```
→ L[✓] G[ ]  my-plugins/oh-my-pi
  L[ ] G[ ]  my-plugins/show-sys-prompt.ts
```

- **L** = local (project `.pi/extensions/`)
- **G** = global (`~/.pi/agent/extensions/`)
- **←/→** switch between L/G column
- **Space** toggle checkbox
- **Type** to fuzzy search
- **Esc** close → confirm dialog if changes exist → apply + reload

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

## How it works

Activation creates a relative symlink from the target extensions dir to the source:

```
.pi/extensions/oh-my-pi -> ../../my-plugins/oh-my-pi
```

Deactivation removes the symlink. Refuses to remove non-symlink files (shows a warning).

After confirming changes, triggers `/reload` to pick up the new extension set.
