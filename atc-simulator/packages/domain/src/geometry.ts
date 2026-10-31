// Planar geometry in nautical miles. Map x grows east, y grows south.
// Heading is degrees clockwise from north (0 up, 90 right).
import type { Point } from "./contracts.ts"

export function distanceNm(a: Point, b: Point): number {
    return Math.hypot(b.x - a.x, b.y - a.y)
}

export function travelSeconds(distance: number, speedKnots: number): number {
    if (!(speedKnots > 0)) throw new Error("speedKnots must be positive")
    return (distance / speedKnots) * 3600
}

export function headingDeg(from: Point, to: Point): number {
    const deg = (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI
    return ((deg % 360) + 360) % 360
}

// Move toward a target without overshooting it.
export function moveToward(from: Point, to: Point, distance: number): Point {
    const total = distanceNm(from, to)
    if (total <= distance || total === 0) return { x: to.x, y: to.y }
    const f = distance / total
    return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f }
}

export function polarOffset(center: Point, angleRad: number, radius: number): Point {
    return { x: center.x + radius * Math.cos(angleRad), y: center.y + radius * Math.sin(angleRad) }
}
