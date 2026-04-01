"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Camera, RefreshCw, LogOut } from "lucide-react"
import { motion, AnimatePresence } from "motion/react"

// ─── Egg image pools (one per color, 6 variants each) ────────────────────────

const EGG_POOL: Record<string, string[]> = {
  yellow: Array.from({ length: 6 }, (_, i) => `/eggs/egg-yellow-${i}.png`),
  pink:   Array.from({ length: 6 }, (_, i) => `/eggs/egg-pink-${i}.png`),
  green:  Array.from({ length: 6 }, (_, i) => `/eggs/egg-green-${i}.png`),
  blue:   Array.from({ length: 6 }, (_, i) => `/eggs/egg-blue-${i}.png`),
  purple: Array.from({ length: 6 }, (_, i) => `/eggs/egg-purple-${i}.png`),
}
const ALL_EGG_COLORS = Object.keys(EGG_POOL)
const ALL_EGG_SRCS   = Object.values(EGG_POOL).flat()

// ─── Difficulty (driven by elapsed seconds) ───────────────────────────────────

function getDifficulty(elapsed: number) {
  const t = Math.min(elapsed / 120, 1)   // fully ramped at 2 minutes
  return {
    speed:       1.5 + t * 3.5,           // 1.5 → 5.0
    maxFruits:   Math.round(1 + t * 6),   // 1 → 7
    candyChance: 0.15 + t * 0.20,         // 15% → 35%
    spawnCool:   0.9 - t * 0.5,           // 0.9s → 0.4s cooldown
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CANDIES       = ["🍎", "🍊", "🍋", "🍇", "🍓", "🍌"]
const SHINY_CHANCE  = 0.08
const SHINY_VALUE   = 10
const MOUTH_OPEN_RATIO = 0.28
const CATCH_RADIUS  = 52
const EGG_SIZE      = 64
const EMOJI_SIZE    = 48
const HS_KEY        = "easter-frenzy-highscore"

// ─── Sound effects ────────────────────────────────────────────────────────────

function playChomp(ctx: AudioContext) {
  const t = ctx.currentTime
  const bufLen = Math.floor(ctx.sampleRate * 0.07)
  const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufLen)
  const noise = ctx.createBufferSource()
  noise.buffer = buf
  const filter = ctx.createBiquadFilter()
  filter.type = "bandpass"; filter.frequency.value = 1000; filter.Q.value = 1.2
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.6, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07)
  noise.connect(filter); filter.connect(gain); gain.connect(ctx.destination)
  noise.start(t)
}

function playBlah(ctx: AudioContext) {
  const t = ctx.currentTime
  const osc = ctx.createOscillator()
  osc.type = "sawtooth"
  osc.frequency.setValueAtTime(230, t)
  osc.frequency.exponentialRampToValueAtTime(75, t + 0.38)
  const lfo = ctx.createOscillator(); lfo.frequency.value = 9
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 18
  lfo.connect(lfoGain); lfoGain.connect(osc.frequency)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.2, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42)
  osc.connect(gain); gain.connect(ctx.destination)
  lfo.start(t); osc.start(t); lfo.stop(t + 0.42); osc.stop(t + 0.42)
}

function playShinyCatch(ctx: AudioContext) {
  const t = ctx.currentTime
  for (const [freq, delay] of [[880, 0], [1320, 0.1]] as [number, number][]) {
    const osc = ctx.createOscillator()
    osc.type = "sine"; osc.frequency.value = freq
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, t + delay)
    gain.gain.linearRampToValueAtTime(0.3, t + delay + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.25)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start(t + delay); osc.stop(t + delay + 0.3)
  }
}

// ─── Mouth helpers ────────────────────────────────────────────────────────────

function getMouthInfo(lms: { x: number; y: number }[], w: number, h: number) {
  const ul = lms[13], ll = lms[14], ml = lms[61], mr = lms[291]
  const gapY  = Math.abs(ll.y - ul.y) * h
  const width = Math.abs(mr.x - ml.x) * w
  const ratio = width > 0 ? gapY / width : 0
  const cx = ((ml.x + mr.x) / 2) * w
  const cy = ((ul.y + ll.y) / 2) * h
  return { cx, cy, ratio }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScorePopup { id: number; value: number }

interface Fruit {
  id: number
  imageSrc: string | null
  emoji: string
  x: number; y: number
  speed: number; wobble: number; wobbleAmp: number
  eaten: boolean; eatAnim: number
  isCandy: boolean; isShiny: boolean
}

type GameState = "idle" | "countdown" | "playing" | "gameover"

// ─── Component ────────────────────────────────────────────────────────────────

export function EasterFrenzy() {
  const videoRef    = useRef<HTMLVideoElement>(null)
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const detectorRef = useRef<any>(null)
  const rafRef      = useRef<number>(0)
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const audioCtxRef = useRef<AudioContext | null>(null)

  // Game refs (rAF loop — no stale closures)
  const fruitsRef      = useRef<Fruit[]>([])
  const livesRef       = useRef(3)
  const scoreRef       = useRef(0)
  const gameTimeRef    = useRef(0)
  const lastTimeRef    = useRef(0)
  const nextFruitId    = useRef(0)
  const gameStateRef   = useRef<GameState>("idle")
  const spawnCoolRef   = useRef(0)

  // React state (UI)
  const [gameState, setGameState]     = useState<GameState>("idle")
  const [lives, setLives]             = useState(3)
  const [score, setScore]             = useState(0)
  const [highScore, setHighScore]     = useState(0)
  const [gameTime, setGameTime]       = useState(0)
  const [countdown, setCountdown]     = useState(3)
  const [cameraReady, setCameraReady] = useState(false)
  const [loadingModel, setLoadingModel] = useState(false)
  const [scorePopups, setScorePopups] = useState<ScorePopup[]>([])
  const [lifeFlash, setLifeFlash]     = useState(false)

  // Load high score from localStorage on mount
  useEffect(() => {
    const saved = parseInt(localStorage.getItem(HS_KEY) || "0")
    if (saved > 0) setHighScore(saved)
  }, [])

  // ── Spawn ──────────────────────────────────────────────────────────────────
  const spawnFruit = useCallback((canvas: HTMLCanvasElement) => {
    const diff = getDifficulty(gameTimeRef.current)
    const isCandy = Math.random() < diff.candyChance
    const speed   = diff.speed * (0.8 + Math.random() * 0.4)
    const isShiny = !isCandy && Math.random() < SHINY_CHANCE
    const spawnSz = isCandy ? EMOJI_SIZE : EGG_SIZE

    let imageSrc: string | null = null
    let emoji = ""
    if (isCandy) {
      emoji = CANDIES[Math.floor(Math.random() * CANDIES.length)]
    } else {
      const colorName = ALL_EGG_COLORS[Math.floor(Math.random() * ALL_EGG_COLORS.length)]
      const pool = EGG_POOL[colorName]
      imageSrc = pool[Math.floor(Math.random() * pool.length)]
    }

    fruitsRef.current.push({
      id: nextFruitId.current++,
      imageSrc, emoji,
      x: spawnSz + Math.random() * (canvas.width - spawnSz * 2),
      y: -spawnSz,
      speed,
      wobble: Math.random() * Math.PI * 2,
      wobbleAmp: 20 + Math.random() * 30,
      eaten: false, eatAnim: 0,
      isCandy, isShiny,
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
    const W = canvas.width, H = canvas.height

    // Mirror webcam
    ctx.save(); ctx.scale(-1, 1); ctx.drawImage(video, -W, 0, W, H); ctx.restore()

    // Face detection
    const result = detectorRef.current.detectForVideo(video, ts)
    let mouthOpen = false, mouthX = W / 2, mouthY = H * 0.65

    if (result.faceLandmarks?.length > 0) {
      const lms      = result.faceLandmarks[0]
      const mirrored = lms.map((l: any) => ({ x: 1 - l.x, y: l.y }))
      const info     = getMouthInfo(mirrored, W, H)
      mouthX = info.cx; mouthY = info.cy
      mouthOpen = info.ratio > MOUTH_OPEN_RATIO

      const ringColor = mouthOpen ? "rgba(74,222,128,0.85)" : "rgba(255,255,255,0.35)"
      ctx.beginPath()
      ctx.arc(mouthX, mouthY, CATCH_RADIUS, 0, Math.PI * 2)
      ctx.strokeStyle = ringColor
      ctx.lineWidth   = mouthOpen ? 3 : 1.5
      ctx.setLineDash(mouthOpen ? [] : [6, 4])
      ctx.stroke(); ctx.setLineDash([])

      if (mouthOpen) {
        ctx.beginPath()
        ctx.arc(mouthX, mouthY, 6, 0, Math.PI * 2)
        ctx.fillStyle = "rgba(74,222,128,0.9)"; ctx.fill()
      }
    }

    // ── Game logic ─────────────────────────────────────────────────────────
    if (gameStateRef.current === "playing") {
      gameTimeRef.current += dt
      setGameTime(Math.floor(gameTimeRef.current))

      const diff = getDifficulty(gameTimeRef.current)

      // Spawn
      spawnCoolRef.current -= dt
      const active = fruitsRef.current.filter(f => !f.eaten && f.y < H).length
      if (active < diff.maxFruits && spawnCoolRef.current <= 0) {
        spawnFruit(canvas)
        spawnCoolRef.current = diff.spawnCool * (0.7 + Math.random() * 0.6)
      }

      fruitsRef.current = fruitsRef.current.filter(f => f.y < H + 80 || f.eatAnim > 0)

      for (const fruit of fruitsRef.current) {
        const size = fruit.imageSrc ? EGG_SIZE : EMOJI_SIZE

        if (!fruit.eaten) {
          fruit.y += fruit.speed * dt * 60
          fruit.wobble += dt * 1.2
          const fx = fruit.x + Math.sin(fruit.wobble) * fruit.wobbleAmp
          const dx = fx - mouthX, dy = fruit.y - mouthY
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < CATCH_RADIUS && mouthOpen) {
            fruit.eaten = true; fruit.eatAnim = 1

            // Sound
            const audio = audioCtxRef.current
            if (audio) {
              if (fruit.isShiny) playShinyCatch(audio)
              else if (!fruit.isCandy) playChomp(audio)
              else playBlah(audio)
            }

            if (fruit.isCandy) {
              // Lose a life
              livesRef.current -= 1
              setLives(livesRef.current)
              setLifeFlash(true)
              setTimeout(() => setLifeFlash(false), 350)

              if (livesRef.current <= 0) {
                gameStateRef.current = "gameover"
                setGameState("gameover")
                const final = scoreRef.current
                const prev  = parseInt(localStorage.getItem(HS_KEY) || "0")
                if (final > prev) {
                  localStorage.setItem(HS_KEY, String(final))
                  setHighScore(final)
                }
              }
            } else {
              const pts = fruit.isShiny ? SHINY_VALUE : 1
              scoreRef.current += pts
              setScore(scoreRef.current)
              const popupId = nextFruitId.current++
              setScorePopups(prev => [...prev, { id: popupId, value: pts }])
              setTimeout(() => setScorePopups(prev => prev.filter(p => p.id !== popupId)), 800)
            }
          } else {
            // Draw fruit
            ctx.save()
            ctx.shadowColor = fruit.isShiny ? "rgba(255,215,0,0.95)" : "rgba(0,0,0,0.4)"
            ctx.shadowBlur  = fruit.isShiny ? 24 : 10
            if (fruit.imageSrc) {
              const img = imgCacheRef.current.get(fruit.imageSrc)
              if (img) ctx.drawImage(img, fx - size / 2, fruit.y - size / 2, size, size)
            } else {
              ctx.font = `${size}px serif`
              ctx.textAlign = "center"; ctx.textBaseline = "middle"
              ctx.fillText(fruit.emoji, fx, fruit.y)
            }
            ctx.restore()

            // Orbiting gold sparkles for shiny eggs
            if (fruit.isShiny) {
              for (let i = 0; i < 4; i++) {
                const angle = fruit.wobble * 2.5 + (i / 4) * Math.PI * 2
                const r = size * 0.7
                ctx.save()
                ctx.beginPath()
                ctx.arc(fx + Math.cos(angle) * r, fruit.y + Math.sin(angle) * r, 4, 0, Math.PI * 2)
                ctx.fillStyle = "rgba(255,215,0,1)"
                ctx.shadowColor = "rgba(255,215,0,0.9)"; ctx.shadowBlur = 8
                ctx.fill(); ctx.restore()
              }
            }
          }

        } else if (fruit.eatAnim > 0) {
          fruit.eatAnim -= dt * 3
          const scale = 1 + (1 - fruit.eatAnim) * 1.5
          ctx.save()
          ctx.globalAlpha = fruit.eatAnim
          ctx.translate(fruit.x + Math.sin(fruit.wobble) * fruit.wobbleAmp, fruit.y)
          ctx.scale(scale, scale)
          if (fruit.imageSrc) {
            const img = imgCacheRef.current.get(fruit.imageSrc)
            if (img) ctx.drawImage(img, -size / 2, -size / 2, size, size)
          } else {
            ctx.font = `${size}px serif`
            ctx.textAlign = "center"; ctx.textBaseline = "middle"
            ctx.fillText(fruit.emoji, 0, 0)
          }
          ctx.globalAlpha = 1; ctx.restore()

          if (fruit.eatAnim > 0.3) {
            const sparkleColor = fruit.isCandy
              ? `rgba(248,113,113,${fruit.eatAnim})`
              : fruit.isShiny
              ? `rgba(255,215,0,${fruit.eatAnim})`
              : `rgba(255,220,50,${fruit.eatAnim})`
            const count = fruit.isShiny ? 10 : 6
            const radius = (1 - fruit.eatAnim) * (fruit.isShiny ? 70 : 50)
            for (let i = 0; i < count; i++) {
              const angle = (i / count) * Math.PI * 2
              ctx.beginPath()
              ctx.arc(
                fruit.x + Math.cos(angle) * radius,
                fruit.y + Math.sin(angle) * radius,
                (fruit.isShiny ? 6 : 4) * fruit.eatAnim, 0, Math.PI * 2
              )
              ctx.fillStyle = sparkleColor; ctx.fill()
            }
          }
        }
      }
    }

    rafRef.current = requestAnimationFrame(runLoop)
  }, [spawnFruit])

  // ── Camera + image preload ─────────────────────────────────────────────────
  const initCamera = useCallback(async () => {
    setLoadingModel(true)
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()

      const cache = imgCacheRef.current
      await Promise.all(
        ALL_EGG_SRCS.map(src =>
          new Promise<void>(resolve => {
            if (cache.has(src)) { resolve(); return }
            const img = new Image()
            img.onload = () => { cache.set(src, img); resolve() }
            img.onerror = () => resolve()
            img.src = src
          })
        )
      )

      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision")
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      )
      detectorRef.current = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO", numFaces: 1,
      })

      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
      streamRef.current = stream
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play() }

      setCameraReady(true); setLoadingModel(false)
      rafRef.current = requestAnimationFrame(runLoop)
    } catch (e) {
      console.error(e); setLoadingModel(false)
    }
  }, [runLoop])

  // ── Start game ─────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    fruitsRef.current = []
    setScorePopups([])
    livesRef.current  = 3
    scoreRef.current  = 0
    gameTimeRef.current = 0
    spawnCoolRef.current = 0
    lastTimeRef.current  = 0
    nextFruitId.current  = 0
    setLives(3); setScore(0); setGameTime(0)
    setCountdown(3)
    setGameState("countdown")
    gameStateRef.current = "countdown"

    let count = 3
    const tick = setInterval(() => {
      count -= 1; setCountdown(count)
      if (count <= 0) {
        clearInterval(tick)
        setGameState("playing")
        gameStateRef.current = "playing"
      }
    }, 1000)
  }, [])

  const exitToStart = useCallback(() => {
    fruitsRef.current = []
    gameStateRef.current = "idle"
    setGameState("idle")
  }, [])

  const exitGame = useCallback(() => {
    fruitsRef.current = []
    gameStateRef.current = "idle"
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setCameraReady(false); setGameState("idle")
  }, [])

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-slate-950 overflow-hidden select-none" style={{ fontFamily: "var(--font-nunito)" }}>
      <div className="relative flex-1 min-h-0 flex items-center justify-center">
        <video ref={videoRef} className="absolute opacity-0 pointer-events-none" muted playsInline />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />

        {/* ── Red life-loss flash ──────────────────────────────────────────── */}
        <AnimatePresence>
          {lifeFlash && (
            <motion.div
              className="absolute inset-0 bg-red-500/40 pointer-events-none z-30"
              initial={{ opacity: 1 }} animate={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
            />
          )}
        </AnimatePresence>

        {/* ── HUD ─────────────────────────────────────────────────────────── */}
        {gameState === "playing" && (
          <div className="absolute top-0 inset-x-0 z-10 flex items-center h-14 px-4 bg-black/50 pointer-events-none">
            {/* Lives */}
            <div className="flex gap-1">
              {[0, 1, 2].map(i => (
                <span key={i} className={`text-xl transition-all ${i < lives ? "opacity-100" : "opacity-20 grayscale"}`}>❤️</span>
              ))}
            </div>
            {/* Score */}
            <div className="flex-1 flex justify-center">
              <span className="text-2xl font-black text-white tabular-nums">{score}</span>
            </div>
            {/* Time */}
            <span className="text-base font-bold text-white/60 tabular-nums w-16 text-right">{gameTime}s</span>
          </div>
        )}

        {/* ── Score popups ─────────────────────────────────────────────────── */}
        <AnimatePresence>
          {scorePopups.map(popup => (
            <motion.div
              key={popup.id}
              className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"
              initial={{ opacity: 1, y: 0, scale: 0.7 }}
              animate={{ opacity: 0, y: -100, scale: 1.3 }}
              transition={{ duration: popup.value > 1 ? 0.9 : 0.75, ease: "easeOut" }}
            >
              <span
                className={`font-black leading-none ${popup.value > 1 ? "text-yellow-300" : "text-green-400"}`}
                style={{
                  fontSize: popup.value > 1 ? 120 : 96,
                  fontFamily: "var(--font-nunito)",
                  textShadow: popup.value > 1
                    ? "0 0 40px rgba(255,215,0,0.95), 0 0 80px rgba(255,215,0,0.5)"
                    : "0 0 32px rgba(74,222,128,0.9)",
                }}
              >
                +{popup.value}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* ── Floating Exit ────────────────────────────────────────────────── */}
        {cameraReady && gameState !== "idle" && (
          <button
            onClick={exitToStart}
            className="absolute top-4 right-4 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/40 hover:bg-black/70 text-white text-sm font-medium transition-all backdrop-blur-sm border border-white/20"
          >
            <LogOut className="w-3.5 h-3.5" />
            Exit
          </button>
        )}

        {/* ── Start screen ─────────────────────────────────────────────────── */}
        {!cameraReady && !loadingModel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-pink-950 via-purple-950 to-sky-950" />
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              {["🥚", "🐣", "🐰", "🌷", "🌸", "🐇", "🦋", "🐥", "🌼", "🪺"].map((emoji, i) => (
                <div key={i} className="absolute text-4xl animate-bounce" style={{
                  left: `${(i * 11) % 90}%`, top: `${(i * 17 + 5) % 75}%`,
                  animationDelay: `${i * 0.3}s`, animationDuration: `${2 + (i % 3) * 0.5}s`, opacity: 0.35,
                }}>{emoji}</div>
              ))}
            </div>
            <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
              <div className="flex items-center gap-3">
                <img src="/eggs/egg-yellow-0.png" className="w-16 h-16" alt="" />
                <img src="/eggs/egg-pink-0.png"   className="w-16 h-16" alt="" />
                <img src="/eggs/egg-blue-0.png"   className="w-16 h-16" alt="" />
              </div>
              <div className="text-center">
                <h1 className="text-7xl text-white mb-3 tracking-tight text-center" style={{ fontFamily: "var(--font-erica-one)" }}>
                  Easter <span className="text-pink-400">Frenzy</span>
                </h1>
                <p className="text-white text-lg max-w-sm mx-auto text-center">
                  Catch eggs to score — avoid fruit or lose a life. Survive as long as you can!
                </p>
                {highScore > 0 && (
                  <p className="text-yellow-400 text-base font-bold mt-2">🏆 Best: {highScore}</p>
                )}
              </div>
              <button
                onClick={initCamera}
                className="mt-4 flex items-center gap-2 px-8 py-4 rounded-2xl bg-pink-500 hover:bg-pink-400 active:scale-95 text-white font-bold text-lg transition-all shadow-lg shadow-pink-900/50 hover:scale-105"
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
            <p className="text-white text-base">Loading…</p>
          </div>
        )}

        {/* ── Ready ─────────────────────────────────────────────────────────── */}
        {cameraReady && gameState === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/60">
            <div className="text-center">
              <h2 className="text-5xl text-white mb-2" style={{ fontFamily: "var(--font-erica-one)" }}>Ready?</h2>
              <p className="text-white text-xl">Catch eggs — avoid fruit!</p>
              <p className="text-white/70 text-lg mt-1">3 lives · ✨ Shiny eggs = 10 pts</p>
              {highScore > 0 && (
                <p className="text-yellow-400 text-base font-bold mt-2">🏆 Best: {highScore}</p>
              )}
            </div>
            <button
              onClick={startGame}
              className="mt-4 px-8 py-3 rounded-xl bg-pink-500 hover:bg-pink-400 text-white font-bold text-lg transition-colors"
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
              <p className="text-white text-base font-bold uppercase tracking-widest mb-1">Survive!</p>
              <p className="text-white/60 text-sm mt-1">3 lives · shiny eggs ✨ = 10 pts · speed increases over time</p>
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

        {/* ── Game Over ─────────────────────────────────────────────────────── */}
        {gameState === "gameover" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/85">
            <div className="text-6xl">💔</div>
            <div className="text-center">
              <p className="text-red-400 text-sm font-bold uppercase tracking-widest mb-1">Game Over</p>
              <p className="text-6xl font-black text-white mb-2 tabular-nums">{score}</p>
              {score > 0 && score >= highScore ? (
                <p className="text-yellow-400 text-lg font-bold">🏆 New high score!</p>
              ) : highScore > 0 ? (
                <p className="text-white/50 text-base">Best: {highScore}</p>
              ) : null}
              <p className="text-white/50 text-sm mt-1">Survived {gameTime}s</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={startGame}
                className="flex items-center gap-2 px-7 py-3 rounded-xl bg-pink-500 hover:bg-pink-400 text-white font-bold text-lg transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Try Again
              </button>
              <button
                onClick={exitToStart}
                className="flex items-center gap-2 px-5 py-3 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium transition-colors text-base"
              >
                <LogOut className="w-4 h-4" />
                Menu
              </button>
            </div>
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
