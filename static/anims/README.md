# MIST crystal animations (not committed)

The animated WebPs the Console shows in the header, the thinking spinner, the rail live-state markers and the transcript wallpaper come from the private `BaesTheorem/mist-anims` repo (`~/Documents/mist-anims`). They are rendered files (about 16 MB for 19 animations in 7 looks at 96 px, plus about 110 MB for the same set at 256 px, which the wallpaper uses), so they stay out of this repo.

To (re)build them:

    cd ~/Documents/mist-anims && npm install
    node render.mjs --pack --webp-only              # 256 px -> dist/webp   (wallpaper)
    node render.mjs --pack --webp-only --size=96    # 96 px  -> dist/webp96 (chrome)
    ~/Documents/mist-console/bin/sync-anims

Layout here: `<look>/<anim>.webp` is the 96 px set, `256/<look>/<anim>.webp` the wallpaper set. Without the 96 px set the Console falls back to the static logo and the flat rhombus markers; without the 256 px set only the wallpaper stays still.
