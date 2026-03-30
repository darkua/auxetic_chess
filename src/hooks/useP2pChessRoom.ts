import P2PCF from 'p2pcf'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getP2pcfOptions } from '../p2pcfOptions'

export type CaptureCounts = {
  white: number
  black: number
}

export type OnlineIntent = 'host' | 'join' | 'watch'

export type GameNetSnapshot = {
  fen: string
  capturedPieces: string[]
  captureCounts: CaptureCounts
}

export type P2pConnectionPhase = 'inactive' | 'starting' | 'signalling' | 'mesh' | 'error'

export type P2pConnectionBanner = {
  phase: P2pConnectionPhase
  tone: 'neutral' | 'pending' | 'ok' | 'error'
  title: string
  detail: string
} | null

type PresenceMsg = {
  t: 'presence'
  clientId: string
  intent: OnlineIntent
  ts: number
}

type SyncMsg = {
  t: 'sync'
} & GameNetSnapshot & { version: number }

type MoveMsg = {
  t: 'move'
  by: string
} & GameNetSnapshot & { version: number }

type NetMsg = PresenceMsg | SyncMsg | MoveMsg

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function encodeMsg(msg: NetMsg): ArrayBuffer {
  const u8 = encoder.encode(JSON.stringify(msg))
  const buf = new ArrayBuffer(u8.byteLength)
  new Uint8Array(buf).set(u8)
  return buf
}

function decodeMsg(data: ArrayBuffer): NetMsg | null {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(data))
    if (!parsed || typeof parsed !== 'object' || !('t' in parsed)) {
      return null
    }
    return parsed as NetMsg
  } catch {
    return null
  }
}

function getOrCreateClientId(): string {
  const key = 'auxetic-p2p-client-id'
  try {
    let id = localStorage.getItem(key)
    if (!id) {
      id = `p-${crypto.randomUUID()}`
      localStorage.setItem(key, id)
    }
    return id
  } catch {
    return `p-${Math.random().toString(36).slice(2)}-${Date.now()}`
  }
}

export function useClientId(): string {
  const [id] = useState(() => getOrCreateClientId())
  return id
}

export type P2pRoomSeat = {
  whiteId: string | null
  blackId: string | null
  myPlayColor: 'w' | 'b' | null
}

export function useP2pChessRoom(options: {
  active: boolean
  roomId: string
  intent: OnlineIntent
  clientId: string
  getSnapshot: () => GameNetSnapshot
  onApplyRemote: (snapshot: GameNetSnapshot) => void
}) {
  const { active, roomId, intent, clientId, getSnapshot, onApplyRemote } = options

  const p2pRef = useRef<P2PCF | null>(null)
  const lastVersionRef = useRef(0)
  const getSnapshotRef = useRef(getSnapshot)
  const onApplyRemoteRef = useRef(onApplyRemote)
  const signallingCompleteRef = useRef(false)

  useEffect(() => {
    getSnapshotRef.current = getSnapshot
    onApplyRemoteRef.current = onApplyRemote
  }, [getSnapshot, onApplyRemote])

  const [presence, setPresence] = useState<Record<string, OnlineIntent>>({})
  const [peerCount, setPeerCount] = useState(0)
  const [connectionPhase, setConnectionPhase] =
    useState<P2pConnectionPhase>('inactive')

  const seat = useMemo((): P2pRoomSeat => {
    const hosts = Object.entries(presence)
      .filter(([, r]) => r === 'host')
      .map(([id]) => id)
      .sort()
    const joiners = Object.entries(presence)
      .filter(([, r]) => r === 'join')
      .map(([id]) => id)
      .sort()

    const whiteId = hosts[0] ?? null
    const blackId = joiners[0] ?? null

    let myPlayColor: 'w' | 'b' | null = null
    if (clientId === whiteId) {
      myPlayColor = 'w'
    } else if (clientId === blackId) {
      myPlayColor = 'b'
    }

    return { whiteId, blackId, myPlayColor }
  }, [presence, clientId])

  const connectionBanner = useMemo((): P2pConnectionBanner => {
    if (!active) {
      return null
    }

    switch (connectionPhase) {
      case 'inactive':
        return null
      case 'starting':
        return {
          phase: 'starting',
          tone: 'pending',
          title: 'Starting WebRTC',
          detail:
            'Creating keys and reaching the signalling worker. This step stays slower to save worker requests.',
        }
      case 'signalling':
        return {
          phase: 'signalling',
          tone: 'pending',
          title: 'Waiting for P2P mesh',
          detail:
            'Signalling is running, but no data-channel peers are connected yet. Share the room link so White / Black / spectators can join.',
        }
      case 'mesh':
        return {
          phase: 'mesh',
          tone: 'ok',
          title: 'Mesh connected',
          detail: `${peerCount} peer${peerCount === 1 ? '' : 's'} in the WebRTC mesh — board updates travel peer-to-peer, not through Cloudflare on every move.`,
        }
      case 'error':
        return {
          phase: 'error',
          tone: 'error',
          title: 'Connection failed',
          detail:
            'WebRTC (ICE) did not complete. Use HTTPS; in Firefox try a non-private window. If it persists, your network may block the public TURN relay — set VITE_WEBRTC_EXTRA_ICE_JSON with your own TURN server.',
        }
      default:
        return null
    }
  }, [active, connectionPhase, peerCount])

  const broadcastPresence = useCallback((p2p: P2PCF) => {
    const msg: PresenceMsg = { t: 'presence', clientId, intent, ts: Date.now() }
    p2p.broadcast(encodeMsg(msg))
  }, [clientId, intent])

  const emitPresenceSoon = useCallback(() => {
    const p2p = p2pRef.current
    if (!p2p) {
      return
    }
    broadcastPresence(p2p)
  }, [broadcastPresence])

  useEffect(() => {
    if (!active || !roomId) {
      queueMicrotask(() => setConnectionPhase('inactive'))
      return
    }

    let cancelled = false
    signallingCompleteRef.current = false
    const p2pOpts = getP2pcfOptions()
    const p2p = new P2PCF(clientId, roomId, p2pOpts)
    p2pRef.current = p2p
    lastVersionRef.current = 0

    const presenceIntervalMs = Math.min(
      120_000,
      Math.max(20_000, p2pOpts.slowPollingRateMs ?? 45_000),
    )

    const syncFromPeers = () => {
      if (cancelled || p2pRef.current !== p2p) {
        return
      }
      const n = p2p.peers.size
      setPeerCount(n)
      if (signallingCompleteRef.current) {
        setConnectionPhase(n > 0 ? 'mesh' : 'signalling')
      }
    }

    queueMicrotask(() => {
      if (cancelled) {
        return
      }
      setConnectionPhase('starting')
      setPeerCount(0)
      setPresence({ [clientId]: intent })
    })

    const onPeerConnect = (_peer: { id: string; client_id: string }) => {
      const snap = getSnapshotRef.current()
      const shouldSendSync = intent === 'host' || lastVersionRef.current > 0
      if (shouldSendSync) {
        const sync: SyncMsg = {
          t: 'sync',
          fen: snap.fen,
          capturedPieces: snap.capturedPieces,
          captureCounts: snap.captureCounts,
          version: lastVersionRef.current,
        }
        try {
          p2p.send(_peer as Parameters<P2PCF['send']>[0], encodeMsg(sync))
        } catch {
          /* ignore */
        }
      }
      broadcastPresence(p2p)
      syncFromPeers()
    }

    const onPeerClose = () => {
      syncFromPeers()
    }

    const handleMessage = (_peer: { client_id: string }, data: ArrayBuffer) => {
      const msg = decodeMsg(data)
      if (!msg) {
        return
      }

      if (msg.t === 'presence') {
        setPresence((prev) => {
          const next = { ...prev, [msg.clientId]: msg.intent }
          return next
        })
        return
      }

      if (msg.t === 'sync') {
        if (msg.version >= lastVersionRef.current) {
          lastVersionRef.current = msg.version
          onApplyRemoteRef.current({
            fen: msg.fen,
            capturedPieces: msg.capturedPieces,
            captureCounts: msg.captureCounts,
          })
        }
        return
      }

      if (msg.t === 'move') {
        if (msg.version > lastVersionRef.current && msg.by !== clientId) {
          lastVersionRef.current = msg.version
          onApplyRemoteRef.current({
            fen: msg.fen,
            capturedPieces: msg.capturedPieces,
            captureCounts: msg.captureCounts,
          })
        }
        return
      }
    }

    p2p.on('peerconnect', onPeerConnect)
    p2p.on('peerclose', onPeerClose)
    p2p.on('msg', handleMessage)

    void (async () => {
      try {
        await p2p.start()
        if (cancelled) {
          return
        }
        signallingCompleteRef.current = true
        syncFromPeers()
      } catch {
        if (!cancelled) {
          queueMicrotask(() => setConnectionPhase('error'))
        }
      }
    })()

    broadcastPresence(p2p)

    const tick = window.setInterval(() => {
      broadcastPresence(p2p)
    }, presenceIntervalMs)

    return () => {
      cancelled = true
      signallingCompleteRef.current = false
      window.clearInterval(tick)
      p2p.destroy()
      if (p2pRef.current === p2p) {
        p2pRef.current = null
      }
      queueMicrotask(() => {
        setPeerCount(0)
        setPresence({})
        setConnectionPhase('inactive')
      })
    }
  }, [active, roomId, clientId, intent, broadcastPresence])

  const notifyLocalMove = useCallback(
    (snapshot: GameNetSnapshot) => {
      const p2p = p2pRef.current
      if (!p2p) {
        return
      }
      lastVersionRef.current += 1
      const v = lastVersionRef.current
      const msg: MoveMsg = {
        t: 'move',
        by: clientId,
        fen: snapshot.fen,
        capturedPieces: snapshot.capturedPieces,
        captureCounts: snapshot.captureCounts,
        version: v,
      }
      p2p.broadcast(encodeMsg(msg))
    },
    [clientId],
  )

  useEffect(() => {
    if (active) {
      emitPresenceSoon()
    }
  }, [active, emitPresenceSoon, seat.whiteId, seat.blackId])

  return {
    peerCount,
    seat,
    notifyLocalMove,
    connectionPhase,
    connectionBanner,
  }
}
