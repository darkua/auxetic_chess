declare module 'p2pcf' {
  type P2PCFPeer = {
    id: string
    client_id: string
  }

  type P2PCFOptions = {
    workerUrl?: string
    stunIceServers?: RTCConfiguration['iceServers']
    turnIceServers?: RTCConfiguration['iceServers']
    networkChangePollIntervalMs?: number
    stateExpirationIntervalMs?: number
    stateHeartbeatWindowMs?: number
    fastPollingDurationMs?: number
    fastPollingRateMs?: number
    slowPollingRateMs?: number
    idlePollingAfterMs?: number
    idlePollingRateMs?: number
    rtcPeerConnectionOptions?: RTCConfiguration
    rtcPeerConnectionProprietaryConstraints?: MediaTrackConstraints
    sdpTransform?: (sdp: string) => string
  }

  export default class P2PCF {
    sessionId: string
    roomId: string
    peers: Map<string, P2PCFPeer & Record<string, unknown>>

    constructor(clientId: string, roomId: string, options?: P2PCFOptions)

    start(): Promise<void>
    destroy(): void
    broadcast(data: ArrayBuffer): void
    send(peer: P2PCFPeer, data: ArrayBuffer): void
    on(event: 'peerconnect', listener: (peer: P2PCFPeer) => void): void
    on(event: 'peerclose', listener: (peer: P2PCFPeer) => void): void
    on(
      event: 'msg',
      listener: (peer: P2PCFPeer, data: ArrayBuffer) => void,
    ): void
  }
}
