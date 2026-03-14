# Detail Height Sync Design

## Goal

Make the desktop scanned-video list panel use the right-side detail panel as its only height baseline so the two cards stay equal-height, the left list never grows taller than the right card, and overflow stays inside the left list without premature clipping.

## Constraints

- This behavior applies only to the desktop two-column layout.
- The full page must keep natural scrolling.
- The right detail panel must not become an internal scroll container.
- The left list panel must avoid artificial viewport caps that create blank space when enough items exist.

## Approach

1. Keep the desktop two-column layout.
2. Measure the rendered height of the right detail card with `ResizeObserver`.
3. Write that height into a CSS custom property on the shared workspace container.
4. Bind the left table card height to that CSS variable.
5. Let the left card layout continue using `auto + 1fr`, so the list header sizes naturally and the scroll region fills the remaining space.
6. Remove the fixed desktop `max-height` clamp from the list scroll region because it conflicts with the right-card baseline.

## Data Flow

- `App.tsx` owns the right-card height sync.
- `ResizeObserver` reacts to preview loads, selection changes, text wrapping, errors, and window size changes that affect the right card height.
- `styles.css` consumes the CSS variable to size the left table card.

## Error Handling

- If `ResizeObserver` is unavailable or the viewport is not desktop width, the layout falls back to the existing CSS behavior.
- If no measured height is available yet, the left card falls back to its normal height rule until the first measurement arrives.

## Verification

- Add regression tests that assert:
  - `.table-card` uses the CSS variable-backed height rule.
  - `.video-summary-scroll` no longer uses the desktop `clamp(...)` max height.
  - `App.tsx` includes the right-card height sync path.
- Run renderer tests and the desktop production build.
