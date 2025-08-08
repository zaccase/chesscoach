
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { OPENINGS } from "./openings";
import "./styles.css";

const ELO_PRESETS = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200];
const DEFAULT_ELO = 1200;
const DEFAULT_DEPTH_DESKTOP = 16;
const DEFAULT_DEPTH_MOBILE = 12;
const MULTIPV = 3;

function pgnTokens(pgn) {
  return pgn.replace(/[0-9]+\.|[?!+#]/g, "").trim().split(/\s+/).filter(Boolean);
}

function detectOpening(movesSAN) {
  const tryMatch = (opening) => {
    const tmp = new Chess();
    const targetSAN = [];
    for (const tok of pgnTokens(opening.pgn)) {
      const legal = tmp.moves({ verbose: true });
      const m = legal.find(
        (mv) => `${mv.from}${mv.to}` === tok || mv.san.replace(/[+#]/g, "") === tok.replace(/[+#]/g, "")
      );
      if (!m) return null;
      targetSAN.push(m.san);
      tmp.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
    }
    for (let i = 0; i < Math.min(targetSAN.length, movesSAN.length); i++) {
      if (targetSAN[i].replace(/[+#]/g, "") !== movesSAN[i].replace(/[+#]/g, "")) return null;
    }
    return { eco: opening.eco, name: opening.name, matchedLen: targetSAN.length };
  };
  let best = null;
  for (const op of OPENINGS) {
    const got = tryMatch(op);
    if (got && (!best || got.matchedLen > best.matchedLen)) best = got;
  }
  return best;
}

// Stockfish adapter using CDN script (window.STOCKFISH())
function useStockfish({ elo, depth, multipv }) {
  const engineRef = useRef(null);
  const [ready, setReady] = useState(false);
  const subs = useRef([]);

  useEffect(() => {
    if (engineRef.current) return;
    const ctor = window.STOCKFISH || window.Stockfish || window.stockfish;
    if (!ctor) {
      console.error("Stockfish not found. Check index.html CDN tag.");
      return;
    }
    const eng = ctor();
    engineRef.current = eng;

    const onMsg = (e) => {
      const text = typeof e === "string" ? e : e?.data || "";
      if (text.includes("uciok")) {
        eng.postMessage("setoption name UCI_LimitStrength value true");
        eng.postMessage(`setoption name UCI_Elo value ${elo}`);
        eng.postMessage(`setoption name MultiPV value ${multipv}`);
        setReady(true);
      }
      subs.current.forEach((fn) => fn(text));
    };
    eng.onmessage = onMsg;
    eng.addEventListener?.("message", onMsg);
    eng.postMessage("uci");
  }, []);

  useEffect(() => {
    if (!engineRef.current || !ready) return;
    engineRef.current.postMessage(`setoption name UCI_Elo value ${elo}`);
    engineRef.current.postMessage(`setoption name MultiPV value ${multipv}`);
  }, [elo, multipv, ready]);

  const on = useCallback((fn) => {
    subs.current.push(fn);
    return () => { subs.current = subs.current.filter((f) => f !== fn); };
  }, []);

  const analyze = useCallback((fen, d = depth) => {
    return new Promise((resolve) => {
      if (!engineRef.current) return resolve({ bestmove: null, cp: 0, lines: [] });

      const eng = engineRef.current;
      let bestmove = null;
      let lastCp = 0;
      const lines = [];
      const tmp = new Chess(fen);

      const off = on((line) => {
        if (!line) return;
        if (line.startsWith("info ")) {
          const mScore = line.match(/score (cp|mate) (-?\d+)/);
          const mPV = line.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
          const mMulti = line.match(/ multipv (\d+)/);
          if (mScore) {
            lastCp = mScore[1] === "cp" ? parseInt(mScore[2], 10) : (mScore[2].startsWith("-") ? -100000 : 100000);
          }
          if (mPV && mMulti) {
            const uci = mPV[1];
            const idx = parseInt(mMulti[1], 10) - 1;
            const legal = tmp.moves({ verbose: true });
            const mv = legal.find((m) => m.from + m.to + (m.promotion || "") === uci);
            if (mv) lines[idx] = { uci, san: mv.san, cp: lastCp };
          }
        }
        if (line.startsWith("bestmove")) {
          bestmove = line.split(" ")[1] || null;
          off();
          resolve({ bestmove, cp: lastCp, lines: lines.filter(Boolean) });
        }
      });

      eng.postMessage("stop");
      eng.postMessage(`position fen ${fen}`);
      eng.postMessage(`go depth ${d}`);
    });
  }, [depth, on]);

  return { ready, analyze };
}

// Helpers
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function gradeFromLoss(cpLoss) {
  const loss = Math.abs(cpLoss) / 100;
  if (loss <= 0.1) return "A+";
  if (loss <= 0.2) return "A";
  if (loss <= 0.5) return "B";
  if (loss <= 0.9) return "C";
  if (loss <= 1.5) return "D";
  return "F";
}

function explainHeuristic(move, before, after) {
  const parts = [];
  if (move.flags?.includes("c")) parts.push("You captured material.");
  if (move.san.includes("+")) parts.push("You gave check.");
  if (move.san.includes("#")) parts.push("Checkmate, nice.");
  const center = new Set(["d4", "d5", "e4", "e5"]);
  if (center.has(move.to)) parts.push("You fought for the center.");
  if (["N", "B"].includes(move.piece.toUpperCase())) parts.push("You developed a minor piece.");
  if (move.san === "O-O" || move.san === "O-O-O") parts.push("You castled your king to safety.");
  const us = after.turn() === "w" ? "b" : "w";
  const attackers = after.moves({ verbose: true }).filter((m) => m.to === move.to && m.color === us);
  const defenders = after.moves({ verbose: true }).filter((m) => m.to === move.to && m.color !== us);
  if (attackers.length > defenders.length) parts.push("The moved piece is under-defended.");
  if (!parts.length) parts.push("Idea makes sense, but there may be a more precise square.");
  return parts.join(" ");
}

// Main component
export default function App() {
  const isMobile = useMemo(() => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent), []);
  const [game, setGame] = useState(() => new Chess());
  const [fen, setFen] = useState(() => game.fen());
  const [orientation, setOrientation] = useState("white");
  const [elo, setElo] = useState(DEFAULT_ELO);
  const [depth, setDepth] = useState(isMobile ? DEFAULT_DEPTH_MOBILE : DEFAULT_DEPTH_DESKTOP);
  const [showHints, setShowHints] = useState(true);
  const [showEval, setShowEval] = useState(true);
  const [showPV, setShowPV] = useState(true);
  const [focus, setFocus] = useState(false);

  const [engineEval, setEngineEval] = useState(0);
  const [pvLines, setPvLines] = useState([]);
  const [coach, setCoach] = useState([]);
  const [candidates, setCandidates] = useState([]);

  const currentSAN = useMemo(() => game.history({ verbose: true }).map((m) => m.san), [game]);
  const openingInfo = useMemo(() => detectOpening(currentSAN), [currentSAN]);

  const engine = useStockfish({ elo, depth, multipv: MULTIPV });

  useEffect(() => {
    let ok = true;
    const run = async () => {
      if (!engine.ready) return;
      const res = await engine.analyze(fen, Math.max(8, Math.min(depth, 18)));
      if (!ok) return;
      setEngineEval(res.cp || 0);
      setPvLines(res.lines || []);
    };
    run();
    return () => { ok = false; };
  }, [fen, engine.ready, depth]);

  const evalPercent = useMemo(() => {
    const t = Math.tanh((engineEval || 0) / 600);
    return Math.round((t + 1) * 50);
  }, [engineEval]);

  const engineMove = useCallback(async () => {
    if (!engine.ready || game.isGameOver()) return;
    const res = await engine.analyze(game.fen(), depth);
    const legal = game.moves({ verbose: true });
    const mv = legal.find((m) => m.from + m.to + (m.promotion || "") === res.bestmove);
    if (mv) {
      game.move(mv);
      setGame(new Chess(game.fen()));
      setFen(game.fen());
    }
  }, [engine.ready, game, depth]);

  const onPieceDrop = async (sourceSquare, targetSquare) => {
    const moveObj = { from: sourceSquare, to: targetSquare, promotion: "q" };
    const move = game.move(moveObj);
    if (!move) return false;

    const beforeFEN = game.fen();
    game.undo();
    const pre = engine.ready ? await engine.analyze(game.fen(), depth) : { cp: 0 };
    const cpBefore = pre.cp || 0;

    game.move(moveObj);
    setGame(new Chess(game.fen()));
    setFen(game.fen());

    const post = engine.ready ? await engine.analyze(game.fen(), depth) : { cp: cpBefore };
    const cpAfter = post.cp || 0;

    const loss = (cpBefore - cpAfter) * (game.turn() === "w" ? 1 : -1);
    const grade = engine.ready ? gradeFromLoss(loss) : "A";
    const note = explainHeuristic(move, new Chess(beforeFEN), game);
    setCoach((f) => [...f, { ply: game.history().length, move: move.san, grade, loss, note }]);

    await engineMove();
    return true;
  };

  const onUndo = () => {
    if (game.history().length === 0) return;
    game.undo();
    game.undo();
    setGame(new Chess(game.fen()));
    setFen(game.fen());
  };

  const newGame = async (color) => {
    const g = new Chess();
    setGame(g);
    setFen(g.fen());
    setCoach([]);
    setOrientation(color);
    if (color === "black") setTimeout(engineMove, 100);
  };

  const getHints = async () => {
    if (!engine.ready) return;
    const res = await engine.analyze(game.fen(), Math.max(8, depth));
    setCandidates((res.lines || []).slice(0, 3));
  };

  const boardSize = useMemo(() => {
    const vw = Math.min(window.innerWidth, 900);
    if (focus) return Math.min(vw - 24, 640);
    if (window.innerWidth < 768) return Math.min(vw - 24, 380);
    return 520;
  }, [focus]);

  const evalBar = (
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
  );

  return (
    <div className="container">
      <div className="header">
        <div className="title">Chess Coach</div>
        <div className="actions">
          <button className="btn" onClick={() => newGame("white")}>New as White</button>
          <button className="btn" onClick={() => newGame("black")}>New as Black</button>
          <button className="btn" onClick={onUndo}>Undo</button>
          <button className="btn" onClick={() => setFocus(v => !v)}>{focus ? "Exit Focus Mode" : "Focus Mode"}</button>
        </div>
      </div>

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
                {ELO_PRESETS.map((e) => <option key={e} value={String(e)}>{e}</option>)}
              </select>
            </label>

            <label className="label">
              Depth
              <input
                type="range"
                min="8"
                max="22"
                step="1"
                value={depth}
                onChange={(e) => setDepth(clamp(parseInt(e.target.value, 10), 8, 22))}
                style={{ width: 160 }}
              />
              <span className="small"> {depth} </span>
            </label>

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <label className="label" style={{ gap: 6 }}>
                <input type="checkbox" checked={showHints} onChange={(e) => setShowHints(e.target.checked)} /> Hints
              </label>
              <label className="label" style={{ gap: 6 }}>
                <input type="checkbox" checked={showEval} onChange={(e) => setShowEval(e.target.checked)} /> Eval bar
              </label>
              <label className="label" style={{ gap: 6 }}>
                <input type="checkbox" checked={showPV} onChange={(e) => setShowPV(e.target.checked)} /> PV
              </label>
            </div>

            <button className="btn" onClick={getHints}>Get hint</button>
          </div>
        </div>

        {!focus && (
          <div className="sidebar">
            <div className="card">
              <div className="cardTitle">Coach</div>
              <div className="scroll">
                {coach.length === 0 ? (
                  <div className="muted">Make a move. I’ll grade it and explain why.</div>
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
                {evalBar}
              </div>
            )}

            {showHints && candidates.length > 0 && (
              <div className="card">
                <div className="cardTitle">Hints</div>
                <ol style={{ margin: 0, paddingLeft: 16 }}>
                  {candidates.map((c, i) => (<li key={i}>{c?.san || c?.uci}</li>))}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
