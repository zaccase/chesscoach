import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Chess } from "chess.js"               // if this errors, try:  import { Chess } from "chess.js/dist/esm/chess.js"
import { Chessboard } from "react-chessboard"
import "./styles.css"

// ---- Config ----
const ELO_PRESETS = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200]
const DEFAULT_ELO = 1200
const MOVETIME_MS = 450          // analysis time per call (keeps UI snappy)
const MULTIPV = 3                // # of candidate lines for hints
const MAX_HINTS = 3              // show top N hints

// Small local opening list
const OPENINGS = [
  { eco: "C20", name: "King's Pawn Game", pgn: "e4" },
  { eco: "C40", name: "King's Knight Opening", pgn: "e4 e5 Nf3" },
  { eco: "C50", name: "Italian Game", pgn: "e4 e5 Nf3 Nc6 Bc4" },
  { eco: "C60", name: "Ruy Lopez", pgn: "e4 e5 Nf3 Nc6 Bb5" },
  { eco: "B30", name: "Sicilian Defense", pgn: "e4 c5" },
  { eco: "C00", name: "French Defense", pgn: "e4 e6" },
  { eco: "B01", name: "Scandinavian Defense", pgn: "e4 d5" },
  { eco: "D00", name: "Queen's Pawn Game", pgn: "d4 d5" },
  { eco: "D06", name: "Slav Defense", pgn: "d4 d5 c4 c6" },
  { eco: "D20", name: "Queen's Gambit Accepted", pgn: "d4 d5 c4 dxc4" },
  { eco: "D30", name: "Queen's Gambit Declined", pgn: "d4 d5 c4 e6" },
  { eco: "E60", name: "King's Indian Defense", pgn: "d4 Nf6 c4 g6" },
]

// ---- Helpers ----
function pgnTokens(pgn) {
  return pgn.replace(/[0-9]+\.|[?!+#]/g, "").trim().split(/\s+/).filter(Boolean)
}
function detectOpening(movesSAN) {
  const tryMatch = (opening) => {
    const tmp = new Chess()
    const target = []
    for (const tok of pgnTokens(opening.pgn)) {
      const legal = tmp.moves({ verbose: true })
      const m = legal.find(
        mv => `${mv.from}${mv.to}` === tok || mv.san.replace(/[+#]/g, "") === tok.replace(/[+#]/g, "")
      )
      if (!m) return null
      target.push(m.san)
      tmp.move({ from: m.from, to: m.to, promotion: m.promotion || "q" })
    }
    for (let i = 0; i < Math.min(target.length, movesSAN.length); i++) {
      if (target[i].replace(/[+#]/g, "") !== movesSAN[i].replace(/[+#]/g, "")) return null
    }
    return { eco: opening.eco, name: opening.name, matchedLen: target.length }
  }
  let best = null
  for (const op of OPENINGS) {
    const got = tryMatch(op)
    if (got && (!best || got.matchedLen > best.matchedLen)) best = got
  }
  return best
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)) }
function gradeFromLoss(cpLoss) {
  const loss = Math.abs(cpLoss) / 100
  if (loss <= 0.1) return "A+"
  if (loss <= 0.2) return "A"
  if (loss <= 0.5) return "B"
  if (loss <= 0.9) return "C"
  if (loss <= 1.5) return "D"
  return "F"
}
function explainHeuristic(move, before, after) {
  const parts = []
  if (move.flags?.includes("c")) parts.push("You captured material.")
  if (move.san.includes("+")) parts.push("You gave check.")
  if (move.san.includes("#")) parts.push("Checkmate, nice.")
  const center = new Set(["d4", "d5", "e4", "e5"])
  if (center.has(move.to)) parts.push("You fought for the center.")
  if (["N", "B"].includes(move.piece.toUpperCase())) parts.push("You developed a minor piece.")
  if (move.san === "O-O" || move.san === "O-O-O") parts.push("You castled your king to safety.")
  const us = after.turn() === "w" ? "b" : "w"
  const attackers = after.moves({ verbose: true }).filter(m => m.to === move.to && m.color === us)
  const defenders = after.moves({ verbose: true }).filter(m => m.to === move.to && m.color !== us)
  if (attackers.length > defenders.length) parts.push("The moved piece is under-defended.")
  if (!parts.length) parts.push("Idea makes sense, but there may be a more precise square.")
  return parts.join(" ")
}

// ---- Stockfish adapter (uses CDN script included in index.html) ----
function useStockfish({ elo, multipv }) {
  const engineRef = useRef(null)
  const [ready, setReady] = useState(false)
  const listeners = useRef([])

  useEffect(() => {
    if (engineRef.current) return
    const ctor = window.STOCKFISH || window.Stockfish || window.stockfish
    if (!ctor) {
      console.error("Stockfish script not found. Make sure index.html includes the CDN <script> tag.")
      return
    }
    const eng = ctor()
    engineRef.current = eng

    const onMsg = (e) => {
      const text = typeof e === "string" ? e : e?.data || ""
      if (text.includes("uciok")) {
        eng.postMessage("setoption name UCI_LimitStrength value true")
        eng.postMessage(`setoption name UCI_Elo value ${elo}`)
        eng.postMessage(`setoption name MultiPV value ${multipv}`)
        eng.postMessage("isready")
      }
      if (text.includes("readyok")) setReady(true)
      listeners.current.forEach(fn => fn(text))
    }
    eng.onmessage = onMsg
    eng.addEventListener?.("message", onMsg)
    eng.postMessage("uci")
  }, [])

  // sync options when user changes ELO or multipv
  useEffect(() => {
    if (!engineRef.current || !ready) return
    engineRef.current.postMessage(`setoption name UCI_Elo value ${elo}`)
    engineRef.current.postMessage(`setoption name MultiPV value ${multipv}`)
  }, [elo, multipv, ready])

  const on = useCallback((fn) => {
    listeners.current.push(fn)
    return () => { listeners.current = listeners.current.filter(f => f !== fn) }
  }, [])

  // Quick analysis with movetime (never hangs)
  const analyze = useCallback((fen, movetime = MOVETIME_MS) => new Promise(resolve => {
    const eng = engineRef.current
    if (!eng) return resolve({ bestmove: null, cp: 0, lines: [] })

    let bestmove = null
    let lastCp = 0
    const lines = []
    const tmp = new Chess(fen)

    const off = on((line) => {
      if (!line) return
      if (line.startsWith("info ")) {
        const mScore = line.match(/score (cp|mate) (-?\d+)/)
        const mPV = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/)
        const mMulti = line.match(/ multipv (\d+)/)
        if (mScore) {
          lastCp = mScore[1] === "cp" ? parseInt(mScore[2], 10) : (mScore[2].startsWith("-") ? -100000 : 100000)
        }
        if (mPV && mMulti) {
          const uci = mPV[1]
          const idx = parseInt(mMulti[1], 10) - 1
          const mv = tmp.moves({ verbose: true }).find(m => m.from + m.to + (m.promotion || "") === uci)
          if (mv) lines[idx] = { uci, san: mv.san, cp: lastCp }
        }
      }
      if (line.startsWith("bestmove")) {
        bestmove = line.split(" ")[1] || null
        off()
        resolve({ bestmove, cp: lastCp, lines: lines.filter(Boolean) })
      }
    })

    eng.postMessage("stop")
    eng.postMessage(`position fen ${fen}`)
    eng.postMessage(`go movetime ${movetime}`)

    // safety timeout in case a message is dropped
    setTimeout(() => {
      off()
      resolve({ bestmove, cp: lastCp, lines: lines.filter(Boolean) })
    }, movetime + 600)
  }), [on])

  return { ready, analyze }
}

// ---- Main component ----
export default function App() {
  const isMobile = useMemo(() => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent), [])
  const [game, setGame] = useState(() => new Chess())
  const [fen, setFen] = useState(() => game.fen())
  const [orientation, setOrientation] = useState("white")
  const [elo, setElo] = useState(DEFAULT_ELO)

  const [showHints, setShowHints] = useState(true)
  const [showEval, setShowEval] = useState(true)
  const [showPV, setShowPV] = useState(true)
  const [focus, setFocus] = useState(false)
  const [sidePickerOpen, setSidePickerOpen] = useState(true)

  const [engineEval, setEngineEval] = useState(0)
  const [pvLines, setPvLines] = useState([])
  const [coach, setCoach] = useState([])        // { ply, move, grade, loss, note }
  const [candidates, setCandidates] = useState([])

  const engine = useStockfish({ elo, multipv: MULTIPV })

  const currentSAN = useMemo(() => game.history({ verbose: true }).map(m => m.san), [game])
  const openingInfo = useMemo(() => detectOpening(currentSAN), [currentSAN])

  // keep a lightweight evaluation current
  useEffect(() => {
    let alive = true
    const run = async () => {
      if (!engine.ready) return
      const res = await engine.analyze(fen, MOVETIME_MS)
      if (!alive) return
      setEngineEval(res.cp || 0)
      setPvLines(res.lines || [])
    }
    const t = setTimeout(run, 120)   // small debounce
    return () => { alive = false; clearTimeout(t) }
  }, [fen, engine.ready])

  const evalPercent = useMemo(() => {
    const t = Math.tanh((engineEval || 0) / 600)   // compress to 0..100
    return Math.round((t + 1) * 50)
  }, [engineEval])

  // Engine plays a reply at your chosen ELO
  const engineMove = useCallback(async () => {
    if (!engine.ready || game.isGameOver()) return
    const res = await engine.analyze(game.fen(), MOVETIME_MS)
    const mv = game.moves({ verbose: true }).find(m => m.from + m.to + (m.promotion || "") === res.bestmove)
    if (mv) {
      game.move(mv)
      setGame(new Chess(game.fen()))
      setFen(game.fen())
    }
  }, [engine.ready, game])

  // Ask side on start
  const newGame = (color) => {
    const g = new Chess()
    setGame(g)
    setFen(g.fen())
    setCoach([])
    setOrientation(color)
    setSidePickerOpen(false)
    if (color === "black") setTimeout(engineMove, 150)  // engine opens as White
  }

  // Player move handler with correct grading and “best move was…”
  const onPieceDrop = async (sourceSquare, targetSquare) => {
    // analyze BEFORE move, to get advice and baseline eval
    const pre = engine.ready ? await engine.analyze(game.fen(), MOVETIME_MS) : { cp: 0, bestmove: null, lines: [] }
    const cpBefore = pre.cp || 0
    const bestUci = pre.bestmove
    const bestSAN = (() => {
      if (!bestUci) return null
      const tmp = new Chess(game.fen())
      const mv = tmp.moves({ verbose: true }).find(m => m.from + m.to + (m.promotion || "") === bestUci)
      return mv?.san || null
    })()

    // try the player's move
    const moveObj = { from: sourceSquare, to: targetSquare, promotion: "q" }
    const move = game.move(moveObj)
    if (!move) return false
    setGame(new Chess(game.fen()))
    setFen(game.fen())

    // analyze AFTER move, then convert eval to player's perspective
    const post = engine.ready ? await engine.analyze(game.fen(), MOVETIME_MS) : { cp: cpBefore }
    const cpAfter = post.cp || 0
    const cpAfterFromPlayer = -cpAfter                 // side to move flipped, so negate

    const cpLoss = cpBefore - cpAfterFromPlayer        // positive = your move worsened your eval
    const grade = gradeFromLoss(cpLoss)

    const heur = explainHeuristic(move, new Chess(), new Chess(game.fen()))
    const better = bestSAN && (bestUci !== (move.from + move.to + (move.promotion || ""))) ? `Stronger was ${bestSAN}. ` : ""
    const note = `${better}${heur}`.trim()

    setCoach(f => [...f, { ply: game.history().length, move: move.san, grade, loss: cpLoss, note }])

    // have engine reply
    await engineMove()
    return true
  }

  // Unlimited undo (rewind both sides if possible)
  const onUndo = () => {
    if (game.history().length === 0) return
    game.undo()
    if (game.history().length > 0) game.undo()
    setGame(new Chess(game.fen()))
    setFen(game.fen())
  }

  const getHints = async () => {
    if (!engine.ready) return
    const res = await engine.analyze(game.fen(), MOVETIME_MS)
    setCandidates((res.lines || []).slice(0, MAX_HINTS))
  }

  const boardSize = useMemo(() => {
    const vw = Math.min(window.innerWidth, 900)
    if (focus) return Math.min(vw - 24, 640)
    if (window.innerWidth < 768) return Math.min(vw - 24, 380)
    return 520
  }, [focus])

  return (
    <div className="container">
      <div className="header">
        <div className="title">Chess Coach</div>
        <div className="actions">
          <button className="btn" onClick={() => setSidePickerOpen(true)}>New Game</button>
          <button className="btn" onClick={onUndo}>Undo</button>
          <button className="btn" onClick={() => setFocus(v => !v)}>{focus ? "Exit Focus Mode" : "Focus Mode"}</button>
          <button className="btn" onClick={() => setOrientation(o => o === "white" ? "black" : "white")}>Flip</button>
        </div>
      </div>

      {sidePickerOpen && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="cardTitle">Choose your side</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => newGame("white")}>Play as White</button>
            <button className="btn" onClick={() => newGame("black")}>Play as Black</button>
          </div>
        </div>
      )}

      <div className={focus ? "main focus" : "main"}>
        <div className="boardWrap">
          <Chessboard
            id="board"
            position={fen}
            onPieceDrop={onPieceDrop}
            boardOrientation={orientation}
            customBoardStyle={{ borderRadius: 16, boxShadow: "0 10px 30px rgba(0,0,0,0.08)" }}
            animationDuration={200}
            areArrowsAllowed
            boardWidth={boardSize}
          />

          <div className="controls">
            <label className="label">
              Strength (Elo)
              <select
                value={String(elo)}
                onChange={(e) => setElo(parseInt(e.target.value, 10))}
                className="select"
              >
                {ELO_PRESETS.map(e => <option key={e} value={String(e)}>{e}</option>)}
              </select>
            </label>

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <label className="label" style={{ gap: 6 }}>
                <input type="checkbox" checked={showHints} onChange={e => setShowHints(e.target.checked)} /> Hints
              </label>
              <label className="label" style={{ gap: 6 }}>
                <input type="checkbox" checked={showEval} onChange={e => setShowEval(e.target.checked)} /> Eval bar
              </label>
              <label className="label" style={{ gap: 6 }}>
                <input type="checkbox" checked={showPV} onChange={e => setShowPV(e.target.checked)} /> PV
              </label>
              <button className="btn" onClick={getHints} disabled={!engine.ready}>Get hint</button>
            </div>
          </div>
        </div>

        {!focus && (
          <div className="sidebar">
            <div className="card">
              <div className="cardTitle">Coach</div>
              <div className="scroll">
                {coach.length === 0 ? (
                  <div className="muted">Make a move. I’ll grade it, show eval change, and tell you the stronger move.</div>
                ) : (
                  coach.map((f, i) => (
                    <div key={i} className="feedback">
                      <div className="feedbackTop">
                        <div>
                          <strong style={{ marginRight: 8 }}>{f.move}</strong>
                          <span className="badge">{f.grade}</span>
                        </div>
                        <div className="delta">Δ {(Math.round(f.loss) / 100).toFixed(2)} pawns</div>
                      </div>
                      <div className="note">{f.note}</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {openingInfo && (
              <div className="card">
                <div className="cardTitle">Opening</div>
                <div style={{ display: "flex", gap: 6, fontSize: 14 }}>
                  <div>{openingInfo.name}</div>
                  <div className="openingEco">({openingInfo.eco})</div>
                </div>
              </div>
            )}

            {showEval && (
              <div className="card">
                <div className="cardTitle">Evaluation</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div className="evalOuter">
                    <div className="evalInner" title={`${engineEval} cp`} style={{ height: `${evalPercent}%` }} />
                  </div>
                  {showPV && (
                    <div style={{ minWidth: 140 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>PV</div>
                      {pvLines.length ? (
                        <ol style={{ margin: 0, paddingLeft: 16 }}>
                          {pvLines.map((l, idx) => <li key={idx}>{l?.san || l?.uci}</li>)}
                        </ol>
                      ) : (
                        <div className="muted">Thinking…</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {showHints && candidates.length > 0 && (
              <div className="card">
                <div className="cardTitle">Hints</div>
                <ol style={{ margin: 0, paddingLeft: 16 }}>
                  {candidates.map((c, i) => (
                    <li key={i}>{c?.san || c?.uci}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
