# Migrating to 4.0: mnx is now Zubra

4.0 renames the project. Nothing else changes: the format, the runtime's behaviour, the compiled code's ABI and every API are the same as 3.6, under the new name. There are no aliases for the old spellings.

| 3.x (mnx) | 4.0 (Zubra) |
|---|---|
| `card.mnx`, `card.mnx.jsx`, `card.mnx.tsx` | `card.zb`, `card.zb.jsx`, `card.zb.tsx` |
| `<mnx-if>`, `<mnx-each>`, `<mnx-slot>`, `<mnx-await>`, … | `<zb-if>`, `<zb-each>`, `<zb-slot>`, `<zb-await>`, … |
| `mnx-props`, `data-mnx-*` | `zb-props`, `data-zb-*` |
| `@mnx/runtime`, `@mnx/compiler`, `@mnx/unplugin`, `@mnx/server`, `@mnx/language-server` | `@zubra/runtime`, `@zubra/compiler`, `@zubra/unplugin`, `@zubra/server`, `@zubra/language-server` |
| `npx mnx …`, `npm create mnx` | `npx zubra …`, `npm create zubra` |
| `cargo install mnx-compiler` | `cargo install zubra` |
| `MNX_COMPILER`, `MNX_MARKER_COMMENT`, … | `ZUBRA_COMPILER`, `ZUBRA_MARKER_COMMENT`, … |
| `MnxModel` (Angular), `createMnx()` (server) | `ZubraModel`, `createZubra()` |
| `res.locals.mnx`, `request.mnx` | `res.locals.zubra`, `request.zubra` |
| `/_mnx/` (served assets) | `/_zubra/` |
| Class names from tags (`<mnx-picker>` → `MnxPicker`) | follow the tag (`<zb-picker>` → `ZbPicker`) |

Components with their own tag names (`<star-rating>`, `<tag-input>`) keep them. Only the `mnx-` directives and attributes change.

## In one command

From the project's root, with a clean working tree so the change can be reviewed:

```sh
# Rename the files…
git ls-files '*.mnx' '*.mnx.jsx' '*.mnx.tsx' | while read f; do git mv "$f" "$(echo "$f" | sed -E 's/\.mnx(\.[jt]sx)?$/.zb\1/')"; done
# …then the spellings in every tracked text file.
git ls-files -z | xargs -0 grep -lIE 'mnx|Mnx|MNX' | xargs sed -i -E \
  -e 's#@mnx/#@zubra/#g; s/\bcreate-mnx\b/create-zubra/g; s/\bMNX_/ZUBRA_/g' \
  -e 's/\bMnx(Model|ElementClass|Error|Options|Element)\b/Zubra\1/g; s/\bcreateMnx\b/createZubra/g' \
  -e 's/\b(locals|request)\.mnx\b/\1.zubra/g; s#/_mnx/#/_zubra/#g' \
  -e 's/\bMnx([A-Z])/Zb\1/g; s/\.mnx\b/.zb/g; s/\bmnx-/zb-/g; s/\bnpx mnx\b/npx zubra/g'
npm uninstall @mnx/runtime @mnx/compiler @mnx/unplugin && npm install @zubra/runtime @zubra/compiler @zubra/unplugin
```

On macOS, use `sed -i ''`. Then run your build and tests: `zubra check` reports anything the sed missed, such as an `<mnx-if>` built from a string.

The repository moved too, to https://github.com/journey-to-code-org/zubra (the old URL redirects).
