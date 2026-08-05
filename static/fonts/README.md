# Vendored fonts

Faces for the Console's font picker, served locally (`fonts.css`) so text renders
with no network and nothing phones home. All are SIL Open Font License 1.1, the
copies from Google Fonts; each family's license text sits beside it as
`OFL-<slug>.txt`. Only the `latin` and `latin-ext` subsets are kept, in woff2 —
about 1 MB for the whole set.

| Family | Slug | Why it's here |
| --- | --- | --- |
| Raleway | `raleway` | Alex asked for it. Geometric sans, distinctive single-story `w`. |
| Poiret One | `poiretone` | The most literally art nouveau of the set: thin, high-waisted, Mucha-poster lettering. |
| Italiana | `italiana` | Slim nouveau roman, wide caps. |
| Marcellus | `marcellus` | Roman inscriptional; the quiet, readable end of the same era. |
| Cinzel Decorative | `cinzeldecorative` | Ornamented caps with swashes. Display only. |
| Josefin Sans | `josefinsans` | 1920s geometric, the deco side of the border. |
| Playfair Display | `playfairdisplay` | High-contrast Belle Époque didone. |
| Cormorant Garamond | `cormorantgaramond` | Delicate old-style serif, very fine hairlines. |
| Yeseva One | `yesevaone` | Heavy nouveau display with curved terminals. |
| Berkshire Swash | `berkshireswash` | Nouveau script, signage flavor. Display only. |

To add another: append it to `FAMILIES` in the fetch step (the picker reads
`FONTS` in `app.js`; `fonts.css` is what actually loads the file), pull the
matching `OFL.txt`, and add a row here.

The display faces (Cinzel Decorative, Yeseva One, Berkshire Swash) set the whole
UI when picked, code blocks included. That's the picker's nature, not a bug — but
they are not fonts to read a diff in.
