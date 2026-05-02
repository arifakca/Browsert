# Browsert

Simple multiplayer browser RTS — 10 soldiers per human player vs a 10-soldier AI, free-for-all.

## Live demo

[**Play the demo**](https://arifakca.github.io/Browsert/) — open the link, share it with friends, their soldiers join the same match automatically.

The demo is published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`. To enable it the first time: **repo Settings → Pages → Build and deployment → Source: GitHub Actions**, then re-run the latest workflow (or push any commit to `main`).

## Controls

- **Tap** a soldier (or left-click) to select it. **Drag a rectangle** to box-select.
- **Tap empty ground** with units selected — or **right-click** on desktop — to issue a move order.
- **Shift** extends the current selection.
- Soldiers auto-attack the nearest enemy of any other team in range.

Works on mobile browsers via Pointer Events; landscape orientation recommended.

## Run locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

No build step, no dependencies — `index.html` loads `game.js` as an ES module and pulls
[Trystero](https://github.com/dmotz/trystero) from a CDN for WebRTC peer-to-peer networking.
