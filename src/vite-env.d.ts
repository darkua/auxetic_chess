/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_P2PCF_WORKER_URL?: string
  /** Default 4000. Polling interval (ms) while peers are changing (ICE/signalling). */
  readonly VITE_P2PCF_FAST_POLL_MS?: string
  /** Default 12000. How long (ms) “fast” polling lasts after peer-list changes. */
  readonly VITE_P2PCF_FAST_WINDOW_MS?: string
  /** Default 45000. Interval (ms) between worker checks when the room is stable. */
  readonly VITE_P2PCF_SLOW_POLL_MS?: string
  /** Default 90000. After this many ms without peer-list changes, switch to idle poll rate. */
  readonly VITE_P2PCF_IDLE_AFTER_MS?: string
  /** Default 60000. Interval (ms) between worker checks in idle mode. */
  readonly VITE_P2PCF_IDLE_POLL_MS?: string
  /** Default 60000. How often (ms) to recheck STUN/reflexive addresses. */
  readonly VITE_P2PCF_NETWORK_POLL_MS?: string
  /** Default 180000. Signalling state TTL (ms) on the worker. */
  readonly VITE_P2PCF_STATE_EXPIRE_MS?: string
  /** Default 45000. Heartbeat window (ms) before refresh writes. */
  readonly VITE_P2PCF_STATE_HEARTBEAT_MS?: string
  /**
   * Optional JSON array of RTCIceServer objects appended after public STUN/TURN
   * (e.g. your own Metered/Twilio TURN credentials).
   */
  readonly VITE_WEBRTC_EXTRA_ICE_JSON?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
