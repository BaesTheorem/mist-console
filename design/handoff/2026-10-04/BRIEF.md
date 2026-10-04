# MIST Console: phone layout

Brief started 2026-10-04.

## Product

The iPhone app is a native shell around the Console web page. Under 760 px the page uses its phone layout. One person uses it, mostly to start a quick chat or check on a running one.

## The problem

The phone layout is too cluttered, and New Chat is hard to reach (it sits at the bottom of the chat drawer).

## Screens (see Phone.dc.html)

0. Now: the current layout, for comparison.
1. Chat: New Chat in the top bar, a full-width title, one status line, no per-message icons.
2. Drawer: New Chat first, quiet rows, pin and archive on swipe, footer for saved, offline copy and settings.
3. Chat details: a sheet from the title with everything the badge strip showed.
4. Message actions: a long-press sheet in place of the six icons.
5. New chat: keyboard up, repo and model chips.

## Constraints

Same house look as the Mac Console (tokens/md-tokens.css): flat, sharp, no shadows, 1px hairlines, Raleway and Poiret One, Material Symbols Sharp, teal primary. Hit targets 44 px minimum. Reduced motion has a still form for every animation.

## References

- [Linear mobile (Dribbble)](https://dribbble.com/search/linear-mobile-app): a dense tool made quiet on a phone, actions hidden behind long-press.
- [ChatGPT iOS](https://dribbble.com/search/chatgpt-mobile): New Chat as a top-right compose button, the model as a subtitle.
