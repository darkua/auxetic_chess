import type P2PCF from 'p2pcf'

type P2PCFOptions = NonNullable<ConstructorParameters<typeof P2PCF>[2]>

/**
 * p2pcf sets RTCPeerConnection iceServers to either `stunIceServers` **or** `turnIceServers`
 * based on symmetric-NAT detection — not both. Chrome often connects on STUN-only; Firefox
 * frequently needs relay candidates available, otherwise ICE fails with “add a TURN server”.
 * Passing the same merged list for both options matches common practice (STUN + TURN always).
 */
const PUBLIC_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
]

/** Same open-relay endpoints p2pcf ships by default (Metered). */
const PUBLIC_TURN_SERVERS: RTCIceServer[] = [
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

function buildMergedIceServers(): RTCIceServer[] {
  const extra = parseExtraIceFromEnv()
  return [...PUBLIC_STUN_SERVERS, ...PUBLIC_TURN_SERVERS, ...extra]
}

function parseExtraIceFromEnv(): RTCIceServer[] {
  const raw = import.meta.env.VITE_WEBRTC_EXTRA_ICE_JSON
  if (!raw || raw.trim() === '') {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed as RTCIceServer[]
  } catch {
    return []
  }
}

function parseMs(envVal: string | undefined, fallback: number, min = 500): number {
  if (envVal === undefined || envVal === '') {
    return fallback
  }
  const n = Number(envVal)
  if (!Number.isFinite(n) || n < min) {
    return fallback
  }
  return n
}

/**
 * Defaults favour fewer Cloudflare Worker requests (~1/min slow, ~1/min idle after quiet).
 * Override with VITE_P2PCF_* in .env — see vite-env.d.ts.
 */
export function getP2pcfOptions(): P2PCFOptions {
  const workerUrl = import.meta.env.VITE_P2PCF_WORKER_URL
  const mergedIce = buildMergedIceServers()

  return {
    ...(workerUrl ? { workerUrl } : {}),
    stunIceServers: mergedIce,
    turnIceServers: mergedIce,
    fastPollingRateMs: parseMs(import.meta.env.VITE_P2PCF_FAST_POLL_MS, 4000),
    fastPollingDurationMs: parseMs(import.meta.env.VITE_P2PCF_FAST_WINDOW_MS, 12000),
    slowPollingRateMs: parseMs(import.meta.env.VITE_P2PCF_SLOW_POLL_MS, 45000),
    idlePollingAfterMs: parseMs(import.meta.env.VITE_P2PCF_IDLE_AFTER_MS, 90_000),
    idlePollingRateMs: parseMs(import.meta.env.VITE_P2PCF_IDLE_POLL_MS, 60_000),
    networkChangePollIntervalMs: parseMs(
      import.meta.env.VITE_P2PCF_NETWORK_POLL_MS,
      60_000,
    ),
    stateExpirationIntervalMs: parseMs(
      import.meta.env.VITE_P2PCF_STATE_EXPIRE_MS,
      180_000,
    ),
    stateHeartbeatWindowMs: parseMs(
      import.meta.env.VITE_P2PCF_STATE_HEARTBEAT_MS,
      45_000,
    ),
  }
}

export function getP2pcfPollingSummary(): string {
  const o = getP2pcfOptions()
  const slow = (o.slowPollingRateMs ?? 45_000) / 1000
  const idle = (o.idlePollingRateMs ?? 60_000) / 1000
  const after = (o.idlePollingAfterMs ?? 90_000) / 1000
  return `Signalling targets ~${slow}s between checks, ~${idle}s when idle after ${after}s without peer-list changes.`
}
