# MIST crystal animations (not committed)

The animated WebPs the Console shows in the header, the thinking spinner and the rail live-state markers come from the private `BaesTheorem/mist-anims` repo (`~/Documents/mist-anims`). They are rendered files (about 16 MB for 19 animations in 7 looks at 96 px), so they stay out of this repo.

To (re)build them:

    cd ~/Documents/mist-anims && npm install && node render.mjs --pack --webp-only --size=96
    ~/Documents/mist-console/bin/sync-anims

Without them the Console falls back to the static logo and the flat rhombus markers.
