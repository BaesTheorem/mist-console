"""Every media type /file sends is one WebKit will play."""
import mimetypes

import embeds

# canPlayType "maybe" in a system WKWebView, macOS 26.3, 2026-10-25. Not in it:
# audio/x-flac and audio/mp4a-latm, the types macOS's mime.types gives .flac/.m4a.
WEBKIT_PLAYABLE = {
    "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/ogg",
    "audio/flac", "audio/aac", "audio/x-aac",
    "video/mp4", "video/x-m4v", "video/quicktime", "video/webm",
}


def test_flac_and_m4a_get_webkit_types():
    for ext, mime in embeds.WEBKIT_TYPES.items():
        assert mimetypes.guess_type("song" + ext)[0] == mime


def test_every_embeddable_media_type_is_playable():
    for ext in sorted(embeds.AUDIO_EXTS | embeds.VIDEO_EXTS):
        assert mimetypes.guess_type("clip" + ext)[0] in WEBKIT_PLAYABLE, ext
