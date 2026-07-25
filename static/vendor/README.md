# Vendored Material Design assets

- `md.js` — minified ESM bundle of the @material/web v2.5.0 components the
  Console uses: outlined/text button, icon button (+ filled, filled-tonal,
  outlined variants), icon, switch, outlined text field, divider, linear +
  circular progress. Loaded as `<script type="module">` from index.html.
- `MaterialSymbolsSharp.ttf` — Material Symbols variable icon font, Sharp cut
  (square terminals, matches the flat/sharp house style). @font-face'd in
  `../md-tokens.css`; used via ligatures (`<span class="msi">settings</span>`
  or `<md-icon>send</md-icon>`).

## Rebuilding md.js

```bash
mkdir /tmp/mdbuild && cd /tmp/mdbuild
npm init -y && npm install @material/web esbuild
cat > entry.js <<'EOF'
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/iconbutton/filled-icon-button.js';
import '@material/web/iconbutton/filled-tonal-icon-button.js';
import '@material/web/iconbutton/outlined-icon-button.js';
import '@material/web/icon/icon.js';
import '@material/web/switch/switch.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/divider/divider.js';
import '@material/web/progress/linear-progress.js';
import '@material/web/progress/circular-progress.js';
EOF
./node_modules/.bin/esbuild entry.js --bundle --minify --format=esm --outfile=md.js
```

The color tokens in `../md-tokens.css` were generated with
`@material/material-color-utilities` (see the header comment there for seeds
and neutral-palette settings). Local clones of both upstreams live in
`~/Documents/material-design/`.

The font is copied from `~/Documents/material-design/fonts/`.
