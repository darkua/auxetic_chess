type EvaluationBarProps = {
  cp: number | null
  mate: number | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function toBarPercent(cp: number | null, mate: number | null): number {
  if (mate !== null) {
    return mate > 0 ? 100 : 0
  }

  if (cp === null) {
    return 50
  }

  const normalized = clamp(cp / 600, -1, 1)
  return ((normalized + 1) / 2) * 100
}

function toLabel(cp: number | null, mate: number | null): string {
  if (mate !== null) {
    const sign = mate > 0 ? '+' : '-'
    return `${sign}M${Math.abs(mate)}`
  }

  if (cp === null) {
    return '...'
  }

  const pawns = cp / 100
  const sign = pawns > 0 ? '+' : ''
  return `${sign}${pawns.toFixed(1)}`
}

export function EvaluationBar({ cp, mate }: EvaluationBarProps) {
  const whitePercent = toBarPercent(cp, mate)
  const label = toLabel(cp, mate)

  return (
    <div className="evaluationContainer" aria-label="Evaluation bar">
      <div className="evaluationTrack">
        <div className="evaluationWhite" style={{ width: `${whitePercent}%` }} />
      </div>
      <span className="evaluationLabel">{label}</span>
    </div>
  )
}
