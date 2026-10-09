"""A `#loop` fragment on an audio embed selects the gapless loop player in app.js.
The snapshot index must still see the file behind it (embeds.embedded_paths)."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-embed-test-")

import embeds  # noqa: E402  (needs the env var above first)

ROOT = "/Users/x/Documents/Exobrain harness/tmp/audio"


def test_loop_fragments_are_stripped():
    text = (f"![a]({ROOT}/song.mp3#loop) and ![b]({ROOT}/piece.mp3#loop=2,218) "
            f"and ![c]({ROOT}/w.wav#LOOP= 0.5 , 1.5 )")
    assert embeds.embedded_paths(text) == [f"{ROOT}/song.mp3", f"{ROOT}/piece.mp3", f"{ROOT}/w.wav"]


def test_plain_embeds_and_other_fragments_are_unchanged():
    assert embeds.embedded_paths(f"![a]({ROOT}/plain.mp3)") == [f"{ROOT}/plain.mp3"]
    # Only the loop fragment is special; any other `#` stays part of the name.
    assert embeds.embedded_paths(f"![a]({ROOT}/take#2.mp3)") == [f"{ROOT}/take#2.mp3"]
    assert embeds.embedded_paths(f"![a]({ROOT}/x.mp3#loopy)") == []


def test_balanced_parens_stay_in_the_path():
    d = "/Users/x/Exobrain/Job Listings/Acme - IT Analyst (Remote)"
    text = f"![r]({d}/shot.png) then ![s]({ROOT}/a.mp3) (aside)"
    assert embeds.embedded_paths(text) == [f"{d}/shot.png", f"{ROOT}/a.mp3"]
