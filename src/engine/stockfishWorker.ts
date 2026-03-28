const STOCKFISH_WORKER_PATH = '/stockfish/stockfish-18-lite-single.js'

export function createStockfishWorker(): Worker {
  return new Worker(STOCKFISH_WORKER_PATH)
}
