import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns,
  DETAILS_DEFAULT, DETAILS_MIN, FILES_DEFAULT, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), 0)
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360, details: 360, files: 0 })
  })

  it('closed sidebar keeps its compact rail while closed details contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(360), 0))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED, details: 0, files: 0 })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(1920, open(9999), open(1), 0)
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
    expect(computeColumns(1920, open(1), open(DETAILS_DEFAULT), 0).sidebar).toBe(SIDEBAR_MIN)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 360 + 640 = 1280 > 1250; details concedes to 1250-280-640 = 330.
    const cols = computeColumns(1250, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), 0)
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 330, files: 0 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const cols = computeColumns(300 + 360 + CENTER_MIN, open(300), open(360), 0)
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 360, files: 0 })
    const one = computeColumns(300 + 360 + CENTER_MIN - 1, open(300), open(360), 0)
    expect(one).toEqual({ sidebar: 300, center: CENTER_MIN, details: 359, files: 0 })
  })

  it('step 3: details auto-closes when its min still starves center — sidebar holds its preference', () => {
    // 280 + 300 + 640 = 1220 > 1210 → details 0; sidebar untouched: center = 1210-280 = 930.
    const cols = computeColumns(1210, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), 0)
    expect(cols).toEqual({ sidebar: 280, center: 930, details: 0, files: 0 })
  })

  it('the sidebar never concedes: center absorbs the deficit below CENTER_MIN', () => {
    // 700 < 280+640: sidebar keeps 280, center takes 420 < CENTER_MIN.
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT), 0)
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 420, details: 0, files: 0 })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fits = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN, closed(300), open(DETAILS_DEFAULT), 0)
    expect(fits).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: CENTER_MIN, details: DETAILS_MIN, files: 0 })
    const starved = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN - 1, closed(300), open(DETAILS_DEFAULT), 0)
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: DETAILS_MIN + CENTER_MIN - 1,
      details: 0,
      files: 0,
    })
  })

  it('tiny viewport: details closes, sidebar holds, center takes the remainder', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), 0)
    expect(cols.details).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(1100, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), 0)
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), 0)
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, center takes the rest', () => {
    // Reaches step 3's auto-close with the compact rail sidebar.
    expect(computeColumns(500, closed(300), open(DETAILS_DEFAULT), 0))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 500 - SIDEBAR_COLLAPSED, details: 0, files: 0 })
  })
})

describe('computeColumns — files column', () => {
  it('step 1: files fits beside details at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(FILES_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360 - 320, details: 360, files: 320 })
  })

  it('closed files contributes zero width', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), 0)
    expect(cols.files).toBe(0)
  })

  it('step 2: details shrinks before files yields', () => {
    // 280 + 360 + 320 + 640 = 1600 > 1550; details concedes to 1550-280-320-640 = 310.
    const cols = computeColumns(1550, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(FILES_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 310, files: 320 })
  })

  it('step 3: files shrinks next, details keeps its step-2 width', () => {
    // 280 + 360 + 320 + 640 = 1600 > 1480; details to 1480-280-320-640=240→clamped 300, files to 1480-280-300-640=260.
    const cols = computeColumns(1480, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(FILES_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 300, files: 260 })
  })

  it('step 4: details auto-closes first, files keeps its min', () => {
    // 280 + 300 + 260 + 640 = 1480 > 1220; details to 1220-280-320-640=-20→0, files to max(260, 1220-280-640)=300? Recompute below.
    const cols = computeColumns(1220, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(FILES_DEFAULT))
    // Step 2: d1 = max(300, 1220-280-320-640=-20) → 300; 280+300+320+640=1540 > 1220.
    // Step 3: f1 = max(260, 1220-280-300-640=0) → 260; 280+300+260+640=1480 > 1220.
    // Step 4: f2 = max(260, 1220-280-640=300) → 300; 280+300+640=1220 ≤ 1220 → details 0, files 300.
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 0, files: 300 })
  })

  it('step 5: files auto-closes last, center absorbs the deficit', () => {
    // 280 + 260 + 640 = 1180 > 1000; step4 f2 = max(260, 1000-280-640=80) → 260; 280+260+640=1180 > 1000 → files 0.
    const cols = computeColumns(1000, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(FILES_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 720, details: 0, files: 0 })
  })
})
