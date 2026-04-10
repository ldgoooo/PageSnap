# PageSnap

PageSnap is a minimal Chrome extension that captures the current page as a PNG and copies it to the clipboard, so you can paste it directly into chat apps and editors.

## What it does

- Click the extension button.
- The popup captures the current page.
- The screenshot is copied to the system clipboard as an image.
- Paste it with `Cmd+V` or `Ctrl+V`.

## How to load it

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `/Users/ldg/works/PageSnap`.

## Notes

- The extension captures the page by scrolling, taking viewport snapshots, and stitching them together.
- Fixed or sticky overlays are temporarily hidden during capture to avoid repeated bars in the final image.
- Some Chrome internal pages cannot be captured, such as `chrome://` pages.
- Very long pages may produce large images and can take longer to copy.
