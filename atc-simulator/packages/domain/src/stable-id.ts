// Deterministic identifiers and hashes. A transition retried after a crash
// (same inputs) emits byte-identical messages, so the recipient's
// (runId, messageId) dedup absorbs the replay. Not a security primitive.

function cyrb128(input: string): [number, number, number, number] {
    let h1 = 1779033703
    let h2 = 3144134277
    let h3 = 1013904242
    let h4 = 2773480762
    for (let i = 0; i < input.length; i++) {
        const k = input.charCodeAt(i)
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
    h1 ^= h2 ^ h3 ^ h4
    h2 ^= h1
    h3 ^= h1
    h4 ^= h1
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/** 32 lowercase hex characters. */
export function stableHashHex(input: string): string {
    return cyrb128(input)
        .map(n => n.toString(16).padStart(8, "0"))
        .join("")
}

/** RFC 9562 version-8 (custom) UUID derived from the parts; passes z.uuid(). */
export function stableUuid(...parts: Array<string | number>): string {
    const hex = stableHashHex(parts.join("␟"))
    const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** JSON with object keys sorted at every level, for content hashing. */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}
