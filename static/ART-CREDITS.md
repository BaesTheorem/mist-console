# Decorative art credits (Solarpunk theme)

All botanical/ornamental SVGs used by the Solarpunk theme are genuine
public-domain or CC0 Arts & Crafts / Art Nouveau works, downloaded from
Wikimedia Commons and recolored to the theme palette (forest green `#2F6B3C`,
gold `#B8901F`). Originals are line art (black) on transparent backgrounds.

| File | Source work | Origin | License | Used for |
|---|---|---|---|---|
| `morris-venetian.svg` | William Morris, "Venetian" (tilable vectorization of a Morris & Co. design) | Wikimedia Commons | Public domain | _Retired_ — formerly the faint band down the chat's right column; superseded by the Riom lily wallpaper. Kept for reference. |
| `an-corner.svg` | "Corner Ornament Black Down Left" (antique botanical corner, from metal typeset ornaments) | Wikimedia Commons | CC0 1.0 | Top-left corner bracket framing the conversation |
| `an-tulip.svg` | "Art Nouveau tulip ornament" (*Il progresso fotografico*, 1908) | Wikimedia Commons | Public domain | Slender column down the rail / chat seam |
| `an-headpiece.svg` | "Art Nouveau headpiece, 1904" (French art book) | Wikimedia Commons | Public domain | Centered divider above the composer and below the top bar |
| `an-flourish.svg` | "Art Nouveau flourish" (*Annuaire graphique*, 1909) | Wikimedia Commons | Public domain | Gilded sprays on the quick-access summon box corners |
| `riom-lilies.png` | Georges Riom, Art Nouveau lily wallpaper/textile design panel (sage green ground, white lilies) | period decorative-arts plate | Public domain (author d. pre-1955; design pre-1920s) | Faint full-app ambient wallpaper behind the whole window (all themes) |

Source URLs (Wikimedia `upload.wikimedia.org` direct files):
- Venetian: `commons/e/ec/William_Morris_-_tilable_vectorized_Venetian.svg`
- Corner: `commons/e/e7/Corner_Ornament_Black_Down_Left.svg`
- Tulip: `commons/6/6c/Art_Nouveau_tulip_ornament.svg`
- Headpiece: `commons/3/36/Art_Nouveau_headpiece%2C_1904.svg`
- Flourish: `commons/4/4e/Art_Nouveau_flourish.svg`

To recolor: the source files are single-color (`#000000`, or `#1F1A17` for the
corner). A find/replace on those hex values retints the whole piece.

# Decorative art credits (Clawd theme)

The Clawd theme is Claude Code themed rather than MIST themed. Its **colors**
come from the [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)
pixel-crab sprites; its **artwork does not**, and this is deliberate.

**The upstream artwork is not vendored here, on purpose.** That project's
`assets/LICENSE` reserves all rights on the art and permits it only for
"personal use of the Clawd on Desk application as distributed by this project."
A different app is outside that grant, so no sprite, GIF or icon from it was
copied into this repo. The Clawd character itself is Anthropic's, and the pixel
art of it there is fan-created and non-commercial.

What *was* taken is the palette, which is not ownable, read off the sprites with
a hex census over `assets/svg/*.svg`:

| Hex | Where it appears upstream | Used here for |
|---|---|---|
| `#DE886D` | the crab's body fill (`body-color-group`), 155 uses — by far the dominant ink | The theme's MD3 seed. Survives verbatim as `--md-sys-color-primary-container`. |
| `#40C4FF` | the thought bubble and the yawn tear | `--mist-ext-thinking` |
| `#FFE066` | the sparkles around a finished task | `--mist-ext-user` |
| `#FFB000` | the tool-activity glow | `--mist-ext-warn` |
| `#FF5252` | the error state | `--md-sys-color-error` |

| File | Origin | Used for |
|---|---|---|
| `clawd-wall.svg` | **Original.** Drawn for this repo on its own 28×15 grid: eyes on stalks above the shell, four-wide pincers, six legs. Upstream's crab has its eyes *inside* the torso on a 15×16 grid and no stalks or pincer gap. | Faint centered wallpaper behind the conversation, in place of MIST's mark |
| `CLAWD_MARK` (inline SVG in `app.js`) | **Original.** The same crab cut down to what still reads at 16px. | The thinking spinner's glyph, in place of `MIST_MARK` |

If you ever want the real animated sprites on your own desktop, run the upstream
app itself — that is exactly the use its license does allow.
