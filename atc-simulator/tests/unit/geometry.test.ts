import { expect, test } from "bun:test"
import { distanceNm, headingDeg, moveToward, travelSeconds } from "../../packages/domain/src/geometry.ts"

test("travelSeconds(4, 240) is 60 and distance is Euclidean", () => {
    expect(travelSeconds(4, 240)).toBe(60)
    expect(travelSeconds(3, 180)).toBe(60)
    expect(distanceNm({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(() => travelSeconds(1, 0)).toThrow()
})

test("heading is clockwise from north with y growing south", () => {
    expect(headingDeg({ x: 0, y: 10 }, { x: 0, y: 0 })).toBe(0)
    expect(headingDeg({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(90)
    expect(headingDeg({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(180)
    expect(headingDeg({ x: 10, y: 0 }, { x: 0, y: 0 })).toBe(270)
})

test("moveToward never overshoots", () => {
    expect(moveToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)).toEqual({ x: 4, y: 0 })
    expect(moveToward({ x: 0, y: 0 }, { x: 3, y: 0 }, 4)).toEqual({ x: 3, y: 0 })
})
