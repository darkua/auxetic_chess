import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import type { Square } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { EvaluationBar } from './components/EvaluationBar'
import { createStockfishWorker } from './engine/stockfishWorker'

type EvalInfo = {
  cp: number | null
  mate: number | null
}

type PromotionPiece = 'q' | 'r' | 'b' | 'n'
type GameMode = 'local' | 'ai'
type AppScreen = 'start' | 'mode' | 'aiLevel' | 'game'
type AiLevel = 1 | 2 | 3 | 4 | 5
type ChessPiece = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
type CaptureCounts = {
  white: number
  black: number
}

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

function App() {
  const [screen, setScreen] = useState<AppScreen>('start')
  const [gameMode, setGameMode] = useState<GameMode>('local')
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

  const fen = game.fen()
  const turn = game.turn()
  gameRef.current = game
  turnRef.current = turn
  awaitingAiMoveRef.current = awaitingAiMove

  const isGameScreen = screen === 'game'
  const isAiTurn = gameMode === 'ai' && turn === 'b'
  const currentAiDepth = AI_DEPTH_BY_LEVEL[aiLevel]

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

        // UCI score is from side-to-move perspective. Convert to White perspective.
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
      applyMove(from, to, promotion || undefined)
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
      setAwaitingAiMove(true)
      workerRef.current.postMessage(`go depth ${currentAiDepth}`)
      return
    }

    setAwaitingAiMove(false)
    workerRef.current.postMessage(`go depth ${EVAL_DEPTH}`)
  }, [currentAiDepth, engineReady, fen, game, isAiTurn, isGameScreen, pendingPromotion])

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

      setGame(nextGame)

      if (result.captured) {
        const capturedType = result.captured as ChessPiece
        const capturedColor = result.color === 'w' ? 'b' : 'w'
        const capturedIcon =
          capturedColor === 'w'
            ? WHITE_PIECE_ICONS[capturedType]
            : BLACK_PIECE_ICONS[capturedType]

        setCapturedPieces((current) => [...current, capturedIcon])
        setCaptureCounts((current) => ({
          white: current.white + (result.color === 'w' ? 1 : 0),
          black: current.black + (result.color === 'b' ? 1 : 0),
        }))
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

  const startNewGame = () => {
    setGame(new Chess())
    setCapturedPieces([])
    setCaptureCounts({ white: 0, black: 0 })
    setEvalInfo({ cp: null, mate: null })
    setPendingPromotion(null)
    setAwaitingAiMove(false)
  }

  const startWithMode = (mode: GameMode) => {
    setGameMode(mode)
    startNewGame()
    setScreen('game')
  }

  const startAiWithLevel = (level: AiLevel) => {
    setAiLevel(level)
    setGameMode('ai')
    startNewGame()
    setScreen('game')
  }

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
        </div>
        <button type="button" className="newGameButton" onClick={() => setScreen('start')}>
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
            allowDragging: !game.isGameOver() && pendingPromotion === null && !isAiTurn,
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

      <button type="button" className="newGameButton" onClick={startNewGame}>
        New Game
      </button>
      <button type="button" className="newGameButton" onClick={() => setScreen('mode')}>
        Back to Mode Menu
      </button>
    </main>
  )
}

export default App
