import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import type { Square } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { QRCodeSVG } from 'qrcode.react'
import { EvaluationBar } from './components/EvaluationBar'
import { createStockfishWorker } from './engine/stockfishWorker'
import {
  useClientId,
  useP2pChessRoom,
  type GameNetSnapshot,
  type OnlineIntent,
  type CaptureCounts,
} from './hooks/useP2pChessRoom'
import { getP2pcfPollingSummary } from './p2pcfOptions'

type EvalInfo = {
  cp: number | null
  mate: number | null
}

type PromotionPiece = 'q' | 'r' | 'b' | 'n'
type GameMode = 'local' | 'ai' | 'online'
type AppScreen = 'start' | 'mode' | 'onlineMenu' | 'onlineEnter' | 'aiLevel' | 'game'
type AiLevel = 1 | 2 | 3 | 4 | 5
type ChessPiece = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
type PendingPromotion = {
  from: string
  to: string
  color: 'w' | 'b'
}

const EVAL_DEPTH = 12
const AI_DEPTH_BY_LEVEL: Record<AiLevel, number> = {
  1: 2,
  2: 8,
  3: 10,
  4: 12,
  5: 14,
}
const PROMOTION_CHOICES: PromotionPiece[] = ['q', 'r', 'b', 'n']

const WHITE_PROMOTION_ICONS: Record<PromotionPiece, string> = {
  q: '♕',
  r: '♖',
  b: '♗',
  n: '♘',
}

const BLACK_PROMOTION_ICONS: Record<PromotionPiece, string> = {
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
}

const WHITE_PIECE_ICONS: Record<ChessPiece, string> = {
  k: '♔',
  q: '♕',
  r: '♖',
  b: '♗',
  n: '♘',
  p: '♙',
}

const BLACK_PIECE_ICONS: Record<ChessPiece, string> = {
  k: '♚',
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
  p: '♟',
}

function randomRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) {
    s += chars[Math.floor(Math.random() * chars.length)]!
  }
  return s
}

function normalizeRoomCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

function replaceUrlForOnline(room: string, role: OnlineIntent) {
  const url = new URL(window.location.href)
  url.searchParams.set('room', room)
  url.searchParams.set('role', role)
  window.history.replaceState({}, '', url)
}

function clearOnlineQueryParams() {
  const url = new URL(window.location.href)
  url.searchParams.delete('room')
  url.searchParams.delete('role')
  window.history.replaceState({}, '', url)
}

type UrlBootOnline = {
  roomId: string
  intent: OnlineIntent
  gameMode: GameMode
  screen: AppScreen
}

function readOnlineFromUrl(): UrlBootOnline | null {
  const params = new URLSearchParams(window.location.search)
  const roomRaw = params.get('room')
  const role = params.get('role')
  if (
    !roomRaw ||
    (role !== 'host' && role !== 'join' && role !== 'watch')
  ) {
    return null
  }
  const room = normalizeRoomCode(roomRaw)
  if (room.length < 4) {
    return null
  }
  return {
    roomId: room,
    intent: role,
    gameMode: 'online',
    screen: 'game',
  }
}

function App() {
  const p2pClientId = useClientId()
  const [urlBoot] = useState(() => readOnlineFromUrl())
  const [screen, setScreen] = useState<AppScreen>(urlBoot?.screen ?? 'start')
  const [gameMode, setGameMode] = useState<GameMode>(urlBoot?.gameMode ?? 'local')
  const [onlineIntent, setOnlineIntent] = useState<OnlineIntent>(
    urlBoot?.intent ?? 'host',
  )
  const [onlineRoomId, setOnlineRoomId] = useState(urlBoot?.roomId ?? '')
  const [onlineEnterKind, setOnlineEnterKind] = useState<'join' | 'watch'>('join')
  const [roomCodeInput, setRoomCodeInput] = useState('')

  const [aiLevel, setAiLevel] = useState<AiLevel>(3)
  const [game, setGame] = useState(() => new Chess())
  const [capturedPieces, setCapturedPieces] = useState<string[]>([])
  const [captureCounts, setCaptureCounts] = useState<CaptureCounts>({ white: 0, black: 0 })
  const [evalInfo, setEvalInfo] = useState<EvalInfo>({ cp: null, mate: null })
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null)
  const [engineReady, setEngineReady] = useState(false)
  const [awaitingAiMove, setAwaitingAiMove] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  const gameRef = useRef(game)
  const turnRef = useRef<'w' | 'b'>('w')
  const awaitingAiMoveRef = useRef(false)
  const gameModeRef = useRef(gameMode)
  const gameSnapshotRef = useRef<GameNetSnapshot>({
    fen: new Chess().fen(),
    capturedPieces: [],
    captureCounts: { white: 0, black: 0 },
  })

  const fen = game.fen()
  const turn = game.turn()

  useLayoutEffect(() => {
    gameRef.current = game
    turnRef.current = turn
    awaitingAiMoveRef.current = awaitingAiMove
    gameModeRef.current = gameMode
    gameSnapshotRef.current = {
      fen,
      capturedPieces,
      captureCounts,
    }
  }, [game, turn, awaitingAiMove, gameMode, fen, capturedPieces, captureCounts])

  const isGameScreen = screen === 'game'
  const isAiTurn = gameMode === 'ai' && turn === 'b'
  const currentAiDepth = AI_DEPTH_BY_LEVEL[aiLevel]

  const onApplyRemote = useCallback((snapshot: GameNetSnapshot) => {
    const nextGame = new Chess()
    try {
      nextGame.load(snapshot.fen)
    } catch {
      return
    }
    setGame(nextGame)
    setCapturedPieces(snapshot.capturedPieces)
    setCaptureCounts(snapshot.captureCounts)
    setPendingPromotion(null)
    setAwaitingAiMove(false)
  }, [])

  const getNetworkSnapshot = useCallback(() => gameSnapshotRef.current, [])

  const p2pActive = isGameScreen && gameMode === 'online' && onlineRoomId.length > 0

  const { seat, notifyLocalMove, connectionBanner } = useP2pChessRoom({
    active: p2pActive,
    roomId: onlineRoomId,
    intent: onlineIntent,
    clientId: p2pClientId,
    getSnapshot: getNetworkSnapshot,
    onApplyRemote,
  })

  const isPromotionMove = (sourceSquare: string, targetSquare: string) => {
    const movingPiece = game.get(sourceSquare as Square)
    if (!movingPiece || movingPiece.type !== 'p') {
      return false
    }

    const isLastRank = targetSquare.endsWith('8') || targetSquare.endsWith('1')
    if (!isLastRank) {
      return false
    }

    const legalMoves = game.moves({ verbose: true })
    return legalMoves.some(
      (legalMove) =>
        legalMove.from === sourceSquare &&
        legalMove.to === targetSquare &&
        legalMove.flags.includes('p'),
    )
  }

  const applyMove = (
    sourceSquare: string,
    targetSquare: string,
    promotionPiece?: PromotionPiece,
  ) => {
    const move = {
      from: sourceSquare as Square,
      to: targetSquare as Square,
      ...(promotionPiece ? { promotion: promotionPiece } : {}),
    }

    const nextGame = new Chess(gameRef.current.fen())

    try {
      const result = nextGame.move(move)
      if (!result) {
        return false
      }

      let nextCapturedPieces = capturedPieces
      let nextCaptureCounts = captureCounts

      if (result.captured) {
        const capturedType = result.captured as ChessPiece
        const capturedColor = result.color === 'w' ? 'b' : 'w'
        const capturedIcon =
          capturedColor === 'w'
            ? WHITE_PIECE_ICONS[capturedType]
            : BLACK_PIECE_ICONS[capturedType]

        nextCapturedPieces = [...capturedPieces, capturedIcon]
        nextCaptureCounts = {
          white: captureCounts.white + (result.color === 'w' ? 1 : 0),
          black: captureCounts.black + (result.color === 'b' ? 1 : 0),
        }
      }

      setGame(nextGame)
      setCapturedPieces(nextCapturedPieces)
      setCaptureCounts(nextCaptureCounts)

      if (gameModeRef.current === 'online') {
        notifyLocalMove({
          fen: nextGame.fen(),
          capturedPieces: nextCapturedPieces,
          captureCounts: nextCaptureCounts,
        })
      }

      return true
    } catch {
      return false
    }
  }

  const onDropPiece = (sourceSquare: string, targetSquare: string) => {
    if (isAiTurn) {
      return false
    }

    if (gameMode === 'online') {
      const canMove =
        seat.myPlayColor !== null && seat.myPlayColor === gameRef.current.turn()
      if (!canMove) {
        return false
      }
    }

    if (isPromotionMove(sourceSquare, targetSquare)) {
      const movingPiece = game.get(sourceSquare as Square)
      if (!movingPiece) {
        return false
      }
      setPendingPromotion({ from: sourceSquare, to: targetSquare, color: movingPiece.color })
      return false
    }

    return applyMove(sourceSquare, targetSquare)
  }

  const onSelectPromotionPiece = (promotionPiece: PromotionPiece) => {
    if (!pendingPromotion) {
      return
    }

    applyMove(pendingPromotion.from, pendingPromotion.to, promotionPiece)
    setPendingPromotion(null)
  }

  const onCancelPromotion = () => {
    setPendingPromotion(null)
  }

  const applyMoveRef = useRef(applyMove)
  useLayoutEffect(() => {
    applyMoveRef.current = applyMove
  })

  useEffect(() => {
    if (!isGameScreen) {
      return
    }

    const worker = createStockfishWorker()
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<string>) => {
      const line = event.data
      if (line === 'readyok') {
        setEngineReady(true)
        return
      }

      const scoreMatch = line.match(/\bscore (cp|mate) (-?\d+)/)
      if (scoreMatch) {
        const scoreType = scoreMatch[1]
        const rawScore = Number.parseInt(scoreMatch[2], 10)

        if (Number.isNaN(rawScore)) {
          return
        }

        const whitePerspective = turnRef.current === 'w' ? rawScore : -rawScore

        if (scoreType === 'cp') {
          setEvalInfo({ cp: whitePerspective, mate: null })
        } else {
          setEvalInfo({ cp: null, mate: whitePerspective })
        }
      }

      const bestMoveMatch = line.match(/^bestmove\s([a-h][1-8][a-h][1-8][qrbn]?)/)
      if (!bestMoveMatch || !awaitingAiMoveRef.current) {
        return
      }

      const bestMove = bestMoveMatch[1]
      const from = bestMove.slice(0, 2)
      const to = bestMove.slice(2, 4)
      const promotion = bestMove.slice(4, 5) as PromotionPiece | ''

      setAwaitingAiMove(false)
      applyMoveRef.current(from, to, promotion || undefined)
    }

    worker.postMessage('uci')
    worker.postMessage('isready')

    return () => {
      worker.postMessage('quit')
      worker.terminate()
      workerRef.current = null
      setEngineReady(false)
    }
  }, [isGameScreen])

  useEffect(() => {
    if (!isGameScreen || !engineReady || !workerRef.current) {
      return
    }

    workerRef.current.postMessage('stop')
    workerRef.current.postMessage(`position fen ${fen}`)
    if (!game.isGameOver() && !pendingPromotion && isAiTurn) {
      queueMicrotask(() => setAwaitingAiMove(true))
      workerRef.current.postMessage(`go depth ${currentAiDepth}`)
      return
    }

    queueMicrotask(() => setAwaitingAiMove(false))
    workerRef.current.postMessage(`go depth ${EVAL_DEPTH}`)
  }, [currentAiDepth, engineReady, fen, game, isAiTurn, isGameScreen, pendingPromotion])

  const statusText = useMemo(() => {
    if (pendingPromotion) {
      return 'Choose a promotion piece.'
    }

    if (game.isCheckmate()) {
      return `Checkmate! ${turn === 'w' ? 'Black' : 'White'} wins.`
    }

    if (game.isStalemate()) {
      return 'Draw by stalemate.'
    }

    if (game.isInsufficientMaterial()) {
      return 'Draw by insufficient material.'
    }

    if (game.isThreefoldRepetition()) {
      return 'Draw by threefold repetition.'
    }

    if (game.isDraw()) {
      return 'Draw.'
    }

    return `${turn === 'w' ? 'White' : 'Black'} to move.`
  }, [game, pendingPromotion, turn])

  const allowDragging = useMemo(() => {
    if (game.isGameOver() || pendingPromotion !== null || isAiTurn) {
      return false
    }
    if (gameMode === 'online') {
      return seat.myPlayColor !== null && seat.myPlayColor === turn
    }
    return true
  }, [
    game,
    pendingPromotion,
    isAiTurn,
    gameMode,
    seat.myPlayColor,
    turn,
  ])

  const startNewGame = () => {
    if (gameMode === 'online' && seat.myPlayColor !== 'w') {
      return
    }
    const fresh = new Chess()
    setGame(fresh)
    setCapturedPieces([])
    setCaptureCounts({ white: 0, black: 0 })
    setEvalInfo({ cp: null, mate: null })
    setPendingPromotion(null)
    setAwaitingAiMove(false)
    if (gameMode === 'online') {
      notifyLocalMove({
        fen: fresh.fen(),
        capturedPieces: [],
        captureCounts: { white: 0, black: 0 },
      })
    }
  }

  const startWithMode = (mode: GameMode) => {
    setGameMode(mode)
    startNewGameCore()
    setScreen('game')
  }

  function startNewGameCore() {
    const fresh = new Chess()
    setGame(fresh)
    setCapturedPieces([])
    setCaptureCounts({ white: 0, black: 0 })
    setEvalInfo({ cp: null, mate: null })
    setPendingPromotion(null)
    setAwaitingAiMove(false)
  }

  const startAiWithLevel = (level: AiLevel) => {
    setAiLevel(level)
    setGameMode('ai')
    startNewGameCore()
    setScreen('game')
  }

  const createOnlineGame = () => {
    const code = randomRoomCode()
    setOnlineRoomId(code)
    setOnlineIntent('host')
    setGameMode('online')
    startNewGameCore()
    setScreen('game')
    replaceUrlForOnline(code, 'host')
  }

  const confirmEnterOnlineRoom = () => {
    const code = normalizeRoomCode(roomCodeInput)
    if (code.length < 4) {
      return
    }
    setOnlineRoomId(code)
    setOnlineIntent(onlineEnterKind === 'join' ? 'join' : 'watch')
    setGameMode('online')
    startNewGameCore()
    setScreen('game')
    replaceUrlForOnline(code, onlineEnterKind === 'join' ? 'join' : 'watch')
    setRoomCodeInput('')
  }

  const leaveOnlineToModes = () => {
    clearOnlineQueryParams()
    setOnlineRoomId('')
    setGameMode('local')
    setScreen('mode')
  }

  const shareBase = typeof window !== 'undefined' ? window.location.origin + '/' : '/'
  const spectateUrl =
    gameMode === 'online' && onlineRoomId
      ? `${shareBase}?room=${onlineRoomId}&role=watch`
      : ''
  const blackInviteUrl =
    gameMode === 'online' && onlineRoomId
      ? `${shareBase}?room=${onlineRoomId}&role=join`
      : ''

  const onlineRoleLabel =
    gameMode === 'online'
      ? onlineIntent === 'host'
        ? 'White (host)'
        : onlineIntent === 'join'
          ? 'Black (join)'
          : 'Spectator'
      : ''

  if (screen === 'start') {
    return (
      <main className="startMenu">
        <h1>Two-Player Chess</h1>
        <p>Press play to start the game.</p>
        <button type="button" className="playButton" onClick={() => setScreen('mode')}>
          Play
        </button>
      </main>
    )
  }

  if (screen === 'mode') {
    return (
      <main className="startMenu">
        <h1>Choose Game Type</h1>
        <p>Select how you want to play.</p>
        <div className="modeButtons">
          <button type="button" className="playButton" onClick={() => startWithMode('local')}>
            In Person
          </button>
          <button type="button" className="playButton" onClick={() => setScreen('aiLevel')}>
            Play with AI
          </button>
          <button type="button" className="playButton" onClick={() => setScreen('onlineMenu')}>
            Online
          </button>
        </div>
        <button type="button" className="newGameButton" onClick={() => setScreen('start')}>
          Back
        </button>
      </main>
    )
  }

  if (screen === 'onlineMenu') {
    return (
      <main className="startMenu">
        <h1>Online (P2P)</h1>
        <p>Uses WebRTC via Cloudflare signalling (p2pcf). Two players; anyone else can spectate.</p>
        <div className="modeButtons">
          <button type="button" className="playButton" onClick={createOnlineGame}>
            Create room (play White)
          </button>
          <button
            type="button"
            className="playButton"
            onClick={() => {
              setOnlineEnterKind('join')
              setScreen('onlineEnter')
            }}
          >
            Join as Black
          </button>
          <button
            type="button"
            className="playButton"
            onClick={() => {
              setOnlineEnterKind('watch')
              setScreen('onlineEnter')
            }}
          >
            Spectate
          </button>
        </div>
        <button type="button" className="newGameButton" onClick={() => setScreen('mode')}>
          Back
        </button>
      </main>
    )
  }

  if (screen === 'onlineEnter') {
    return (
      <main className="startMenu">
        <h1>{onlineEnterKind === 'join' ? 'Join as Black' : 'Spectate'}</h1>
        <p>Enter the 6-character room code from the host.</p>
        <input
          className="roomCodeInput"
          value={roomCodeInput}
          onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
          placeholder="e.g. ABC123"
          maxLength={12}
          autoCapitalize="characters"
        />
        <button
          type="button"
          className="playButton"
          onClick={confirmEnterOnlineRoom}
          disabled={normalizeRoomCode(roomCodeInput).length < 4}
        >
          Connect
        </button>
        <button type="button" className="newGameButton" onClick={() => setScreen('onlineMenu')}>
          Back
        </button>
      </main>
    )
  }

  if (screen === 'aiLevel') {
    return (
      <main className="startMenu">
        <h1>Choose AI Level</h1>
        <p>Higher number means smarter Stockfish.</p>
        <div className="levelButtons">
          <button type="button" className="playButton" onClick={() => startAiWithLevel(1)}>
            1
          </button>
          <button type="button" className="playButton" onClick={() => startAiWithLevel(2)}>
            2
          </button>
          <button type="button" className="playButton" onClick={() => startAiWithLevel(3)}>
            3
          </button>
          <button type="button" className="playButton" onClick={() => startAiWithLevel(4)}>
            4
          </button>
          <button type="button" className="playButton" onClick={() => startAiWithLevel(5)}>
            5
          </button>
        </div>
        <button type="button" className="newGameButton" onClick={() => setScreen('mode')}>
          Back
        </button>
      </main>
    )
  }

  return (
    <main className="app">
      <h1>Two-Player Chess</h1>
      <p className="status">{statusText}</p>

      {gameMode === 'online' && (
        <section className="onlinePanel">
          <p className="onlineLine">
            Room <strong>{onlineRoomId}</strong> · {onlineRoleLabel}
          </p>
          {connectionBanner && (
            <div
              className={`connectionStatus connectionStatus--${connectionBanner.tone}`}
              role="status"
            >
              <p className="connectionStatusTitle">{connectionBanner.title}</p>
              <p className="connectionStatusDetail">{connectionBanner.detail}</p>
            </div>
          )}
          {onlineIntent === 'host' && (
            <div className="shareRow">
              <div className="qrBlock">
                <p className="qrLabel">Black joins</p>
                <QRCodeSVG value={blackInviteUrl} size={112} level="M" />
              </div>
              <div className="qrBlock">
                <p className="qrLabel">Spectators</p>
                <QRCodeSVG value={spectateUrl} size={112} level="M" />
              </div>
            </div>
          )}
          <p className="onlineHint">{getP2pcfPollingSummary()}</p>
          <p className="onlineHint onlineHintSecondary">
            {import.meta.env.VITE_P2PCF_WORKER_URL
              ? 'Worker URL from VITE_P2PCF_WORKER_URL.'
              : 'Using the default public p2pcf worker; set VITE_P2PCF_WORKER_URL for your own.'}
          </p>
        </section>
      )}

      <section className="boardWrap">
        <EvaluationBar cp={evalInfo.cp} mate={evalInfo.mate} />
        {pendingPromotion && (
          <section className="promotionTopMenu">
            <p className="promotionTopTitle">Choose your promotion</p>
            <div className="promotionIconRow">
              {PROMOTION_CHOICES.map((piece) => (
                <button
                  key={piece}
                  type="button"
                  className="promotionIconButton"
                  onClick={() => onSelectPromotionPiece(piece)}
                  aria-label={`Promote to ${piece}`}
                >
                  {pendingPromotion.color === 'w'
                    ? WHITE_PROMOTION_ICONS[piece]
                    : BLACK_PROMOTION_ICONS[piece]}
                </button>
              ))}
              <button
                type="button"
                className="promotionCancelInlineButton"
                onClick={onCancelPromotion}
              >
                Cancel
              </button>
            </div>
          </section>
        )}

        <Chessboard
          options={{
            position: fen,
            allowDragging,
            boardStyle: { width: '100%' },
            onPieceDrop: ({ sourceSquare, targetSquare }) => {
              if (!targetSquare) {
                return false
              }
              return onDropPiece(sourceSquare, targetSquare)
            },
          }}
        />

        <section className="capturedTray">
          <p className="capturedTitle">Captured pieces</p>
          <p className="capturedCountLine">
            {gameMode === 'ai'
              ? `You: ${captureCounts.white}  |  Stockfish: ${captureCounts.black}`
              : `White: ${captureCounts.white}  |  Black: ${captureCounts.black}`}
          </p>
          <div className="capturedIcons">
            {capturedPieces.length === 0 ? (
              <span className="capturedEmpty">None yet</span>
            ) : (
              capturedPieces.map((pieceIcon, index) => (
                <span key={`${pieceIcon}-${index}`} className="capturedPiece">
                  {pieceIcon}
                </span>
              ))
            )}
          </div>
        </section>
      </section>

      <button
        type="button"
        className="newGameButton"
        onClick={startNewGame}
        disabled={gameMode === 'online' && seat.myPlayColor !== 'w'}
        title={
          gameMode === 'online' && seat.myPlayColor !== 'w'
            ? 'Only the White (host) player can reset the board.'
            : undefined
        }
      >
        New Game
      </button>
      <button
        type="button"
        className="newGameButton"
        onClick={() => {
          if (gameMode === 'online') {
            leaveOnlineToModes()
          } else {
            setScreen('mode')
          }
        }}
      >
        {gameMode === 'online' ? 'Leave online' : 'Back to Mode Menu'}
      </button>
    </main>
  )
}

export default App
