"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Camera, RefreshCw, ChevronRight, RotateCcw, LogOut } from "lucide-react"
import { motion, AnimatePresence } from "motion/react"

// ─── Stage Definitions ────────────────────────────────────────────────────────

const STAGES = [
  {
    name: "Egg Hunt Beginners",
    emoji: "🥚",
    tagline: "One egg at a time",
    fruits: ["🥚"],
    target: 5,
    timeLimit: 30,
    baseSpeed: 1.6,
    maxFruits: 1,
    color: "#f9a8d4",
  },
  {
    name: "Chick Chase",
    emoji: "🐣",
    tagline: "They're hatching fast!",
    fruits: ["🥚", "🐣"],
    target: 8,
    timeLimit: 35,
    baseSpeed: 2.1,
    maxFruits: 2,
    color: "#fde68a",
  },
  {
    name: "Bunny Scramble",
    emoji: "🐰",
    tagline: "The bunnies are loose",
    fruits: ["🥚", "🐣", "🐰"],
    target: 10,
    timeLimit: 35,
    baseSpeed: 2.6,
    maxFruits: 3,
    color: "#a5f3fc",
  },
  {
    name: "Spring Fling",
    emoji: "🌷",
    tagline: "Blooming chaos",
    fruits: ["🥚", "🐣", "🐇", "🌷", "🌸"],
    target: 12,
    timeLimit: 40,
    baseSpeed: 3.2,
    maxFruits: 5,
    color: "#86efac",
  },
  {
    name: "Easter Egg Madness",
    emoji: "🎉",
    tagline: "The ultimate egg frenzy",
    fruits: ["🥚", "🐣", "🐰", "🐇", "🌷", "🌸", "🦋", "🐥"],
    target: 15,
    timeLimit: 45,
    baseSpeed: 4.0,
    maxFruits: 7,
    color: "#c4b5fd",
  },
]

// Penalty items: fruits (don't eat these on Easter!)
const CANDIES = ["🍎", "🍊", "🍋", "🍇", "🍓", "🍌"]
const CANDY_CHANCE = 0.2         // 20% of spawns are penalty fruits
const MOUTH_OPEN_RATIO = 0.28
const CATCH_RADIUS = 52
const FRUIT_SIZE = 44

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScorePopup {
  id: number
  value: number   // +1 or -1
}

interface Fruit {
  id: number
  emoji: string
  x: number
  y: number
  speed: number
  wobble: number
  wobbleAmp: number
  eaten: boolean
  eatAnim: number
  isCandy: boolean
}

type GameState = "idle" | "countdown" | "playing" | "stage_complete" | "failed" | "victory"

// ─── Mouth helpers ────────────────────────────────────────────────────────────

function getMouthInfo(lms: { x: number; y: number }[], w: number, h: number) {
  const ul = lms[13], ll = lms[14]
  const ml = lms[61], mr = lms[291]
  const gapY = Math.abs(ll.y - ul.y) * h
  const width = Math.abs(mr.x - ml.x) * w
  const ratio = width > 0 ? gapY / width : 0
  const cx = ((ml.x + mr.x) / 2) * w
  const cy = ((ul.y + ll.y) / 2) * h
  return { cx, cy, ratio }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EasterFrenzy() {
  const videoRef    = useRef<HTMLVideoElement>(null)
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const detectorRef = useRef<any>(null)
  const rafRef      = useRef<number>(0)

  // Game refs (rAF loop — no stale closures)
  const fruitsRef          = useRef<Fruit[]>([])
  const stageFruitsRef     = useRef(0)
  const totalScoreRef      = useRef(0)
  const currentStageRef    = useRef(0)
  const timerRef           = useRef(0)
  const lastTimeRef        = useRef(0)
  const nextFruitId        = useRef(0)
  const gameStateRef       = useRef<GameState>("idle")
  const spawnCoolRef       = useRef(0)
  const completedStagesRef = useRef<boolean[]>([false, false, false, false, false])

  // React state (UI)
  const [gameState, setGameState]             = useState<GameState>("idle")
  const [stageFruits, setStageFruits]         = useState(0)
  const [totalScore, setTotalScore]           = useState(0)
  const [currentStage, setCurrentStage]       = useState(0)
  const [timeLeft, setTimeLeft]               = useState(0)
  const [countdown, setCountdown]             = useState(3)
  const [cameraReady, setCameraReady]         = useState(false)
  const [loadingModel, setLoadingModel]       = useState(false)
  const [completedStages, setCompletedStages] = useState<boolean[]>([false, false, false, false, false])
  const [scorePopups, setScorePopups]         = useState<{ id: number; value: number }[]>([])

  // ── Spawn ──────────────────────────────────────────────────────────────────
  const spawnFruit = useCallback((canvas: HTMLCanvasElement) => {
    const stage = STAGES[currentStageRef.current]
    const isCandy = Math.random() < CANDY_CHANCE
    const speed = stage.baseSpeed * (0.8 + Math.random() * 0.4)
    fruitsRef.current.push({
      id: nextFruitId.current++,
      emoji: isCandy
        ? CANDIES[Math.floor(Math.random() * CANDIES.length)]
        : stage.fruits[Math.floor(Math.random() * stage.fruits.length)],
      x: FRUIT_SIZE + Math.random() * (canvas.width - FRUIT_SIZE * 2),
      y: -FRUIT_SIZE,
      speed,
      wobble: Math.random() * Math.PI * 2,
      wobbleAmp: 20 + Math.random() * 30,
      eaten: false,
      eatAnim: 0,
      isCandy,
    })
  }, [])

  // ── Main loop ──────────────────────────────────────────────────────────────
  const runLoop = useCallback((ts: number) => {
    const video  = videoRef.current
    const canvas = canvasRef.current
    const ctx    = canvas?.getContext("2d")
    if (!video || !canvas || !ctx || !detectorRef.current) {
      rafRef.current = requestAnimationFrame(runLoop)
      return
    }

    const dt = lastTimeRef.current ? Math.min((ts - lastTimeRef.current) / 1000, 0.05) : 0.016
    lastTimeRef.current = ts

    canvas.width  = video.videoWidth  || 640
    canvas.height = video.videoHeight || 480
    const W = canvas.width
    const H = canvas.height

    // Mirror webcam
    ctx.save()
    ctx.scale(-1, 1)
    ctx.drawImage(video, -W, 0, W, H)
    ctx.restore()

    // Face detection
    const result = detectorRef.current.detectForVideo(video, ts)
    let mouthOpen = false
    let mouthX = W / 2
    let mouthY = H * 0.65

    if (result.faceLandmarks?.length > 0) {
      const lms = result.faceLandmarks[0]
      const mirrored = lms.map((l: any) => ({ x: 1 - l.x, y: l.y }))
      const info = getMouthInfo(mirrored, W, H)
      mouthX = info.cx
      mouthY = info.cy
      mouthOpen = info.ratio > MOUTH_OPEN_RATIO

      const ringColor = mouthOpen ? "rgba(74,222,128,0.85)" : "rgba(255,255,255,0.35)"
      ctx.beginPath()
      ctx.arc(mouthX, mouthY, CATCH_RADIUS, 0, Math.PI * 2)
      ctx.strokeStyle = ringColor
      ctx.lineWidth = mouthOpen ? 3 : 1.5
      ctx.setLineDash(mouthOpen ? [] : [6, 4])
      ctx.stroke()
      ctx.setLineDash([])

      if (mouthOpen) {
        ctx.beginPath()
        ctx.arc(mouthX, mouthY, 6, 0, Math.PI * 2)
        ctx.fillStyle = "rgba(74,222,128,0.9)"
        ctx.fill()
      }
    }

    // ── Game logic ────────────────────────────────────────────────────────────
    if (gameStateRef.current === "playing") {
      const stage = STAGES[currentStageRef.current]

      // Timer
      timerRef.current -= dt
      if (timerRef.current <= 0) {
        timerRef.current = 0
        gameStateRef.current = "failed"
        setGameState("failed")
      }
      setTimeLeft(Math.ceil(timerRef.current))

      // Spawn
      spawnCoolRef.current -= dt
      const active = fruitsRef.current.filter(f => !f.eaten && f.y < H).length
      if (active < stage.maxFruits && spawnCoolRef.current <= 0) {
        spawnFruit(canvas)
        spawnCoolRef.current = 0.6 + Math.random() * 0.4
      }

      fruitsRef.current = fruitsRef.current.filter(f => f.y < H + 80 || f.eatAnim > 0)

      ctx.font = `${FRUIT_SIZE}px serif`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"

      for (const fruit of fruitsRef.current) {
        if (!fruit.eaten) {
          fruit.y += fruit.speed * dt * 60
          fruit.wobble += dt * 1.2
          const fx = fruit.x + Math.sin(fruit.wobble) * fruit.wobbleAmp

          const dx = fx - mouthX
          const dy = fruit.y - mouthY
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < CATCH_RADIUS && mouthOpen) {
            fruit.eaten = true
            fruit.eatAnim = 1
            if (fruit.isCandy) {
              stageFruitsRef.current = Math.max(0, stageFruitsRef.current - 1)
              totalScoreRef.current = Math.max(0, totalScoreRef.current - 1)
            } else {
              stageFruitsRef.current += 1
              totalScoreRef.current += 1
            }
            setStageFruits(stageFruitsRef.current)
            setTotalScore(totalScoreRef.current)
            const popupId = nextFruitId.current++
            const popupValue = fruit.isCandy ? -1 : 1
            setScorePopups(prev => [...prev, { id: popupId, value: popupValue }])
            setTimeout(() => setScorePopups(prev => prev.filter(p => p.id !== popupId)), 750)

            if (!fruit.isCandy && stageFruitsRef.current >= stage.target) {
              completedStagesRef.current[currentStageRef.current] = true
              setCompletedStages([...completedStagesRef.current])
              const isLast = currentStageRef.current >= STAGES.length - 1
              const nextState = isLast ? "victory" : "stage_complete"
              gameStateRef.current = nextState
              setGameState(nextState)
            }
          } else {
            ctx.save()
            ctx.shadowColor = "rgba(0,0,0,0.5)"
            ctx.shadowBlur = 8
            ctx.fillText(fruit.emoji, fx, fruit.y)
            ctx.restore()
          }
        } else if (fruit.eatAnim > 0) {
          fruit.eatAnim -= dt * 3
          const t = 1 - fruit.eatAnim
          const scale = 1 + t * 1.5
          ctx.save()
          ctx.globalAlpha = fruit.eatAnim
          ctx.translate(fruit.x + Math.sin(fruit.wobble) * fruit.wobbleAmp, fruit.y)
          ctx.scale(scale, scale)
          ctx.fillText(fruit.emoji, 0, 0)
          ctx.globalAlpha = 1
          ctx.restore()

          if (fruit.eatAnim > 0.3) {
            const sparkleColor = fruit.isCandy
              ? `rgba(248, 113, 113, ${fruit.eatAnim})`   // red for candy
              : `rgba(255, 220, 50, ${fruit.eatAnim})`    // gold for fruit
            for (let i = 0; i < 6; i++) {
              const angle = (i / 6) * Math.PI * 2
              const r = (1 - fruit.eatAnim) * 50
              ctx.beginPath()
              ctx.arc(
                fruit.x + Math.cos(angle) * r,
                fruit.y + Math.sin(angle) * r,
                4 * fruit.eatAnim, 0, Math.PI * 2
              )
              ctx.fillStyle = sparkleColor
              ctx.fill()
            }
          }
        }
      }

    }

    rafRef.current = requestAnimationFrame(runLoop)
  }, [spawnFruit])

  // ── Camera init ────────────────────────────────────────────────────────────
  const initCamera = useCallback(async () => {
    setLoadingModel(true)
    try {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision")
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      )
      detectorRef.current = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
      })

      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      setCameraReady(true)
      setLoadingModel(false)
      rafRef.current = requestAnimationFrame(runLoop)
    } catch (e) {
      console.error(e)
      setLoadingModel(false)
    }
  }, [runLoop])

  // ── Stage start ────────────────────────────────────────────────────────────
  const startStage = useCallback((stageIndex: number) => {
    fruitsRef.current = []
    setScorePopups([])
    stageFruitsRef.current = 0
    spawnCoolRef.current = 0
    lastTimeRef.current = 0
    nextFruitId.current = 0
    timerRef.current = STAGES[stageIndex].timeLimit

    currentStageRef.current = stageIndex
    setCurrentStage(stageIndex)
    setStageFruits(0)
    setTimeLeft(STAGES[stageIndex].timeLimit)
    setCountdown(3)
    setGameState("countdown")
    gameStateRef.current = "countdown"

    let count = 3
    const tick = setInterval(() => {
      count -= 1
      setCountdown(count)
      if (count <= 0) {
        clearInterval(tick)
        setGameState("playing")
        gameStateRef.current = "playing"
      }
    }, 1000)
  }, [])

  const startGame = useCallback(() => {
    totalScoreRef.current = 0
    completedStagesRef.current = [false, false, false, false, false]
    setTotalScore(0)
    setCompletedStages([false, false, false, false, false])
    startStage(0)
  }, [startStage])

  // Return to ready screen (camera stays on)
  const exitToStart = useCallback(() => {
    fruitsRef.current = []
    gameStateRef.current = "idle"
    setGameState("idle")
  }, [])

  // Stop camera and return to pre-camera start screen
  const exitGame = useCallback(() => {
    fruitsRef.current = []
    gameStateRef.current = "idle"
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setCameraReady(false)
    setGameState("idle")
  }, [])

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  const stage = STAGES[currentStage]

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-slate-950 overflow-hidden select-none" style={{ fontFamily: "var(--font-nunito)" }}>
      <div className="relative flex-1 min-h-0 flex items-center justify-center">
        <video ref={videoRef} className="absolute opacity-0 pointer-events-none" muted playsInline />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />

        {/* ── Crisp HTML HUD (replaces canvas-drawn HUD) ───────────────────── */}
        {gameState === "playing" && (
          <div className="absolute top-0 inset-x-0 z-10 flex items-center h-14 px-4 bg-black/50 pointer-events-none"
               style={{ fontFamily: "var(--font-nunito)" }}>
            <span className="text-base font-bold" style={{ color: stage.color }}>{stage.name}</span>
            <div className="flex-1 flex justify-center">
              <div className="relative w-48 h-5 rounded-full overflow-hidden bg-white/15">
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-150"
                  style={{ width: `${Math.min((stageFruits / stage.target) * 100, 100)}%`, background: stage.color }}
                />
                <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">
                  {stageFruits} / {stage.target}
                </span>
              </div>
            </div>
            <span className={`text-xl font-bold tabular-nums ${timeLeft <= 10 ? "text-red-400" : "text-white"}`}>
              {timeLeft}s
            </span>
          </div>
        )}

        {/* ── Crisp score popups ────────────────────────────────────────────── */}
        <AnimatePresence>
          {scorePopups.map(popup => (
            <motion.div
              key={popup.id}
              className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"
              initial={{ opacity: 1, y: 0, scale: 0.7 }}
              animate={{ opacity: 0, y: -100, scale: 1.3 }}
              transition={{ duration: 0.75, ease: "easeOut" }}
            >
              <span
                className={`font-black leading-none ${popup.value > 0 ? "text-green-400" : "text-red-400"}`}
                style={{
                  fontSize: 96,
                  fontFamily: "var(--font-nunito)",
                  textShadow: popup.value > 0
                    ? "0 0 32px rgba(74,222,128,0.9)"
                    : "0 0 32px rgba(248,113,113,0.9)",
                }}
              >
                {popup.value > 0 ? "+1" : "-1"}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* ── Floating Exit button (shown during any active game state) ─────── */}
        {cameraReady && gameState !== "idle" && (
          <button
            onClick={exitToStart}
            className="absolute top-4 right-4 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/40 hover:bg-black/70 text-white hover:text-white text-sm font-medium transition-all backdrop-blur-sm border border-white/20"
          >
            <LogOut className="w-3.5 h-3.5" />
            Exit
          </button>
        )}

        {/* ── Start screen ─────────────────────────────────────────────────── */}
        {!cameraReady && !loadingModel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-pink-950 via-purple-950 to-sky-950" />

            {/* Floating Easter bg */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              {["🥚", "🐣", "🐰", "🌷", "🌸", "🐇", "🦋", "🐥", "🌼", "🪺"].map((emoji, i) => (
                <div
                  key={i}
                  className="absolute text-4xl animate-bounce"
                  style={{
                    left: `${(i * 11) % 90}%`,
                    top: `${(i * 17 + 5) % 75}%`,
                    animationDelay: `${i * 0.3}s`,
                    animationDuration: `${2 + (i % 3) * 0.5}s`,
                    opacity: 0.35,
                  }}
                >
                  {emoji}
                </div>
              ))}
            </div>

            <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
              <div className="text-7xl">🥚🐣🌷</div>
              <div className="text-center">
                <h1 className="text-7xl text-white mb-3 tracking-tight text-center" style={{ fontFamily: "var(--font-erica-one)" }}>
                  Easter <span className="text-pink-400">Frenzy</span>
                </h1>
                <p className="text-white text-lg max-w-sm mx-auto text-center">
                  Open your mouth to catch falling Easter eggs — but watch out for sneaky fruits!
                </p>
              </div>

              <button
                onClick={initCamera}
                className="flex items-center gap-2 px-8 py-4 rounded-2xl bg-pink-500 hover:bg-pink-400 active:scale-95 text-white font-bold text-lg transition-all shadow-lg shadow-pink-900/50 hover:scale-105"
              >
                <Camera className="w-5 h-5" />
                Start Camera
              </button>
            </div>
          </div>
        )}

        {/* ── Loading ───────────────────────────────────────────────────────── */}
        {loadingModel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-950">
            <div className="w-12 h-12 rounded-full border-2 border-pink-500 border-t-transparent animate-spin" />
            <p className="text-white text-base">Loading face model…</p>
          </div>
        )}

        {/* ── Ready ─────────────────────────────────────────────────────────── */}
        {cameraReady && gameState === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/60">
            <div className="text-5xl">😮🥚🐣</div>
            <div className="text-center">
              <h2 className="text-5xl text-white mb-2" style={{ fontFamily: "var(--font-erica-one)" }}>Ready?</h2>
              <p className="text-white text-lg">Catch the eggs — avoid the fruit!</p>
              <p className="text-white/70 text-base mt-1">5 stages · Don't let the clock run out</p>
            </div>
            <button
              onClick={startGame}
              className="px-8 py-3 rounded-xl bg-pink-500 hover:bg-pink-400 text-white font-bold text-lg transition-colors"
            >
              Play!
            </button>
            <button
              onClick={exitGame}
              className="flex items-center gap-1.5 text-white/60 hover:text-white text-base transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Exit game
            </button>
          </div>
        )}

        {/* ── Countdown ─────────────────────────────────────────────────────── */}
        {gameState === "countdown" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60 pointer-events-none">
            <div className="text-center">
              <p className="text-white text-base font-bold uppercase tracking-widest mb-1">
                Stage {currentStage + 1} — {stage.name}
              </p>
              <p className="text-white/70 text-base">{stage.tagline}</p>
              <p className="text-white/60 text-sm mt-1">
                Catch {stage.target} eggs in {stage.timeLimit}s
              </p>
            </div>
            <span
              key={countdown}
              className="text-[120px] font-black text-white drop-shadow-lg animate-ping"
              style={{ animationDuration: "0.9s", animationIterationCount: 1 }}
            >
              {countdown === 0 ? "GO!" : countdown}
            </span>
          </div>
        )}

        {/* ── Stage complete ─────────────────────────────────────────────────── */}
        {gameState === "stage_complete" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/75">
            <div className="text-6xl animate-bounce">{stage.emoji}</div>
            <div className="text-center">
              <p className="text-pink-400 text-sm font-bold uppercase tracking-widest mb-1">Stage Complete!</p>
              <h2 className="text-4xl font-bold text-white mb-2">{stage.name}</h2>
              <p className="text-white text-lg">You caught all {stage.target} eggs!</p>
            </div>
            <div className="flex gap-2">
              {STAGES.map((_, i) => (
                <div
                  key={i}
                  className={`w-3 h-3 rounded-full transition-all ${
                    completedStages[i] ? "bg-pink-400 scale-110" : "bg-white/20"
                  }`}
                />
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => startStage(currentStage + 1)}
                className="flex items-center gap-2 px-8 py-3 rounded-xl bg-pink-500 hover:bg-pink-400 text-white font-bold text-lg transition-colors"
              >
                Next Stage
                <ChevronRight className="w-5 h-5" />
              </button>
              <button
                onClick={exitToStart}
                className="flex items-center gap-2 px-5 py-3 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium transition-colors text-base"
              >
                <LogOut className="w-4 h-4" />
                Exit
              </button>
            </div>
          </div>
        )}

        {/* ── Failed ────────────────────────────────────────────────────────── */}
        {gameState === "failed" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/80">
            <div className="text-6xl">😬</div>
            <div className="text-center">
              <p className="text-red-400 text-sm font-bold uppercase tracking-widest mb-1">Time's Up!</p>
              <h2 className="text-4xl font-bold text-white mb-2">{stage.name}</h2>
              <p className="text-white text-lg">
                Got {stageFruits} of {stage.target} —{" "}
                {stage.target - stageFruits === 1
                  ? "so close!"
                  : `${stage.target - stageFruits} short`}
              </p>
            </div>
            <div className="flex gap-2">
              {STAGES.map((_, i) => (
                <div
                  key={i}
                  className={`w-3 h-3 rounded-full transition-all ${
                    completedStages[i]
                      ? "bg-pink-400"
                      : i === currentStage
                      ? "bg-red-400"
                      : "bg-white/20"
                  }`}
                />
              ))}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => startStage(currentStage)}
                className="flex items-center gap-2 px-6 py-3 rounded-xl bg-pink-500 hover:bg-pink-400 text-white font-bold transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                Try Again
              </button>
              <button
                onClick={startGame}
                className="flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold transition-colors text-base"
              >
                <RefreshCw className="w-4 h-4" />
                Restart
              </button>
            </div>
          </div>
        )}

        {/* ── Victory ───────────────────────────────────────────────────────── */}
        {gameState === "victory" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/80">
            <div className="text-6xl">🏆🎉🥚</div>
            <div className="text-center">
              <p className="text-yellow-400 text-sm font-bold uppercase tracking-widest mb-1">Happy Easter!</p>
              <h2 className="text-4xl font-bold text-white mb-2">All Stages Complete!</h2>
              <p className="text-6xl font-bold text-pink-400 mb-1">{totalScore}</p>
              <p className="text-white text-lg">Total eggs collected</p>
            </div>
            <div className="flex gap-2">
              {STAGES.map((_, i) => (
                <div key={i} className="w-3 h-3 rounded-full bg-pink-400 scale-110" />
              ))}
            </div>
            <button
              onClick={startGame}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-pink-500 hover:bg-pink-400 text-white font-bold transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Play Again
            </button>
          </div>
        )}
      </div>

      {/* Bottom status bar */}
      {cameraReady && gameState !== "playing" && gameState !== "countdown" && (
        <div className="shrink-0 flex items-center justify-center gap-2 py-2 bg-slate-900 border-t border-slate-800">
          <div className="w-2 h-2 rounded-full bg-pink-500 animate-pulse" />
          <span className="text-xs text-slate-500">Camera active · Face data stays local</span>
        </div>
      )}
    </div>
  )
}
