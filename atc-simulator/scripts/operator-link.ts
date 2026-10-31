// bun run demo:operator-link: mint a fresh one-time operator join capability (amendment A1).
// Single use, 15-minute expiry. Hand the link over directly; never send it through Relay or commit it.
import { VITE_PORT } from "../packages/domain/src/constants.ts"
import { OPERATOR_INVITE_TTL_MS, joinUrl, mintInvite } from "../server/src/auth.ts"
import { loadConfig } from "../server/src/config.ts"

const config = loadConfig()
const { capability, expiresAtWallMs } = mintInvite(config.authDir, "OPERATOR", null, OPERATOR_INVITE_TTL_MS)
console.log(`Operator token (single use, expires ${new Date(expiresAtWallMs).toLocaleTimeString()}): ${capability}`)
console.log(`  ${joinUrl(config.publicOrigin, capability)}`)
console.log(`  ${joinUrl(`http://127.0.0.1:${VITE_PORT}`, capability)}`)
