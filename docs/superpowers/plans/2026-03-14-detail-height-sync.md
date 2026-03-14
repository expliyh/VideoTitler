# Detail Height Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop scanned-video list panel follow the right detail panel height exactly while keeping whole-page scrolling.

**Architecture:** The renderer `App` measures the right detail card with `ResizeObserver` and exposes the measured value as a CSS custom property on the workspace. Desktop styles consume that property so the left table card matches the right card height, and the left list scroll region fills the remaining card space without using viewport-based clamps.

**Tech Stack:** React 18, TypeScript, CSS, Node test runner

---

## Chunk 1: Regression Coverage

### Task 1: Lock the intended layout contract

**Files:**
- Modify: `apps/desktop/src/renderer/src/styles.test.ts`
- Create: `apps/desktop/src/renderer/src/app-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Add assertions that:
- `.table-card` uses `height: var(--detail-card-height, 100%)`
- `.video-summary-scroll` does not use the desktop `clamp(...)` max height
- `App.tsx` uses `ResizeObserver` and writes `--detail-card-height`

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "apps/desktop/src/renderer/src/styles.test.ts" "apps/desktop/src/renderer/src/app-layout.test.ts"`
Expected: FAIL on the missing CSS variable-backed height rule and missing app sync behavior.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/styles.test.ts apps/desktop/src/renderer/src/app-layout.test.ts
git commit -m "test: lock desktop detail height sync contract"
```

## Chunk 2: Height Sync Implementation

### Task 2: Sync the left card height from the right detail card

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Write minimal implementation**

Add:
- desktop media query constant
- `ref` for the detail card
- `useLayoutEffect` that observes the detail card height
- CSS variable style object for the workspace container

- [ ] **Step 2: Run focused tests**

Run: `node --test "apps/desktop/src/renderer/src/app-layout.test.ts"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/app-layout.test.ts
git commit -m "feat: sync scanned list height to detail card"
```

### Task 3: Update desktop layout rules

**Files:**
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/src/renderer/src/styles.test.ts`

- [ ] **Step 1: Write minimal implementation**

Update the desktop left-card height rule to use the CSS variable and remove the conflicting desktop list `max-height` clamp.

- [ ] **Step 2: Run focused tests**

Run: `node --test "apps/desktop/src/renderer/src/styles.test.ts" "apps/desktop/src/renderer/src/app-layout.test.ts"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/styles.css apps/desktop/src/renderer/src/styles.test.ts apps/desktop/src/renderer/src/app-layout.test.ts
git commit -m "fix: align scanned list height with detail panel"
```

## Chunk 3: Final Verification

### Task 4: Verify the renderer bundle still builds

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/src/renderer/src/styles.test.ts`
- Create: `apps/desktop/src/renderer/src/app-layout.test.ts`

- [ ] **Step 1: Run the full renderer tests**

Run: `node --test "apps/desktop/src/renderer/src/app-state.test.ts" "apps/desktop/src/renderer/src/styles.test.ts" "apps/desktop/src/renderer/src/app-layout.test.ts"`
Expected: PASS

- [ ] **Step 2: Run the desktop build**

Run: `pnpm --filter @videotitler/desktop build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/styles.css apps/desktop/src/renderer/src/styles.test.ts apps/desktop/src/renderer/src/app-layout.test.ts docs/superpowers/specs/2026-03-14-detail-height-sync-design.md docs/superpowers/plans/2026-03-14-detail-height-sync.md
git commit -m "fix: keep scanned list bounded by detail panel"
```
