"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Camera, RefreshCw, LogOut, Timer } from "lucide-react"
import { motion, AnimatePresence } from "motion/react"
import { submitScore, fetchLeaderboard, type LeaderboardEntry } from "@/lib/supabase"

// ─── Egg image pools ──────────────────────────────────────────────────────────

const EGG_POOL: Record<string, string[]> = {
  yellow: Array.from({ length: 6 }, (_, i) => `/eggs/egg-yellow-${i}.svg`),
  pink:   Array.from({ length: 6 }, (_, i) => `/eggs/egg-pink-${i}.svg`),
  green:  Array.from({ length: 6 }, (_, i) => `/eggs/egg-green-${i}.svg`),
  blue:   Array.from({ length: 6 }, (_, i) => `/eggs/egg-blue-${i}.svg`),
  purple: Array.from({ length: 6 }, (_, i) => `/eggs/egg-purple-${i}.svg`),
}
const ALL_EGG_COLORS = Object.keys(EGG_POOL)
const ALL_EGG_SRCS   = Object.values(EGG_POOL).flat()

// ─── Difficulty ───────────────────────────────────────────────────────────────

function getDifficulty(elapsed: number) {
  const t = Math.min(elapsed / 120, 1)
  return {
    speed:       1.5 + t * 3.5,
    maxFruits:   Math.round(5 + t * 3),
    candyChance: 0.15 + t * 0.20,
    spawnCool:   0.45 - t * 0.15,
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CANDIES               = ["🍎", "🍊", "🍋", "🍇", "🍓", "🍌"]
const SHINY_CHANCE          = 0.08
const SHINY_TIME            = 5           // seconds added on golden egg catch
const POWERUP_CHANCE        = 0.03
const SLOW_DURATION         = 4           // seconds
const SLOW_MULT             = 0.35
const FRENZY_INTERVAL       = 40          // seconds between frenzies
const FRENZY_DURATION       = 5           // seconds
const MILESTONES            = [10, 30, 60, 90, 120, 180, 240]
const START_TIME            = 90          // seconds on the clock at game start
const SCORE_TIME_THRESHOLD  = 50          // every N points adds bonus time
const SCORE_TIME_BONUS      = 10          // seconds added per threshold crossed
const MOUTH_OPEN_RATIO      = 0.28
const CATCH_RADIUS          = 52
const EGG_SIZE              = 64
const EMOJI_SIZE            = 48
const HS_KEY                = "easter-frenzy-highscore"

// ─── Sound effects ────────────────────────────────────────────────────────────

function playSqueak(ctx: AudioContext) {
  const t = ctx.currentTime
  const freqs = [520, 720]
  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator(); osc.type = "sine"
    osc.frequency.setValueAtTime(f, t + i * 0.04)
    osc.frequency.exponentialRampToValueAtTime(f * 1.3, t + i * 0.04 + 0.04)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.18, t + i * 0.04)
    gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.04 + 0.07)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start(t + i * 0.04); osc.stop(t + i * 0.04 + 0.08)
  })
}

function playChomp(ctx: AudioContext) {
  const t = ctx.currentTime
  const bufLen = Math.floor(ctx.sampleRate * 0.07)
  const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < bufLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufLen)
  const noise = ctx.createBufferSource(); noise.buffer = buf
  const filter = ctx.createBiquadFilter()
  filter.type = "bandpass"; filter.frequency.value = 1000; filter.Q.value = 1.2
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.6, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07)
  noise.connect(filter); filter.connect(gain); gain.connect(ctx.destination); noise.start(t)
}

function playBlah(ctx: AudioContext) {
  const t = ctx.currentTime
  const osc = ctx.createOscillator(); osc.type = "sawtooth"
  osc.frequency.setValueAtTime(230, t); osc.frequency.exponentialRampToValueAtTime(75, t + 0.38)
  const lfo = ctx.createOscillator(); lfo.frequency.value = 9
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 18
  lfo.connect(lfoGain); lfoGain.connect(osc.frequency)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.2, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42)
  osc.connect(gain); gain.connect(ctx.destination)
  lfo.start(t); osc.start(t); lfo.stop(t + 0.42); osc.stop(t + 0.42)
}

function playShinyCatch(ctx: AudioContext) {
  const t = ctx.currentTime
  for (const [freq, delay] of [[880, 0], [1320, 0.1]] as [number, number][]) {
    const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = freq
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, t + delay)
    gain.gain.linearRampToValueAtTime(0.3, t + delay + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.25)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start(t + delay); osc.stop(t + delay + 0.3)
  }
}

function playPowerup(ctx: AudioContext) {
  const t = ctx.currentTime
  const osc = ctx.createOscillator(); osc.type = "sine"
  osc.frequency.setValueAtTime(400, t); osc.frequency.exponentialRampToValueAtTime(1400, t + 0.3)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.3, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
  osc.connect(gain); gain.connect(ctx.destination); osc.start(t); osc.stop(t + 0.4)
}

function playFrenzySound(ctx: AudioContext) {
  const t = ctx.currentTime
  for (const [freq, delay] of [[400, 0], [600, 0.06], [800, 0.12], [1000, 0.18]] as [number, number][]) {
    const osc = ctx.createOscillator(); osc.type = "square"; osc.frequency.value = freq
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.1, t + delay); gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.12)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.start(t + delay); osc.stop(t + delay + 0.15)
  }
}

// ─── Mouth helpers ────────────────────────────────────────────────────────────

function getMouthInfo(lms: { x: number; y: number }[], w: number, h: number) {
  const ul = lms[13], ll = lms[14], ml = lms[61], mr = lms[291]
  const gapY  = Math.abs(ll.y - ul.y) * h
  const width = Math.abs(mr.x - ml.x) * w
  return {
    ratio: width > 0 ? gapY / width : 0,
    cx: ((ml.x + mr.x) / 2) * w,
    cy: ((ul.y + ll.y) / 2) * h,
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScorePopup { id: number; label: string; isTime?: boolean }
interface Callout    { id: number; text: string; type: "milestone" | "frenzy" }

interface Fruit {
  id: number
  imageSrc: string | null; emoji: string
  x: number; y: number
  speed: number; wobble: number; wobbleAmp: number
  eaten: boolean; eatAnim: number
  isCandy: boolean; isShiny: boolean; isPowerup: boolean
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

  // Game refs
  const fruitsRef             = useRef<Fruit[]>([])
  const livesRef              = useRef(3)
  const scoreRef              = useRef(0)
  const timeLeftRef           = useRef(START_TIME)
  const lastScoreMilestone    = useRef(0)
  const gameTimeRef           = useRef(0)
  const lastTimeRef           = useRef(0)
  const nextFruitId           = useRef(0)
  const gameStateRef          = useRef<GameState>("idle")
  const spawnCoolRef          = useRef(0)
  const milestonesShownRef    = useRef<Set<number>>(new Set())
  const slowEndTimeRef        = useRef(0)
  const frenzyEndTimeRef      = useRef(0)
  const nextFrenzyTimeRef     = useRef(FRENZY_INTERVAL)
  const calloutTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null)

  // React state
  const [gameState, setGameState]     = useState<GameState>("idle")
  const [lives, setLives]             = useState(3)
  const [score, setScore]             = useState(0)
  const [timeLeft, setTimeLeft]       = useState(START_TIME)
  const [highScore, setHighScore]     = useState(0)
  const [gameTime, setGameTime]       = useState(0)
  const [countdown, setCountdown]     = useState(3)
  const [cameraReady, setCameraReady] = useState(false)
  const [loadingModel, setLoadingModel] = useState(false)
  const [scorePopups, setScorePopups] = useState<ScorePopup[]>([])
  const [lifeFlash, setLifeFlash]     = useState(false)
  const [callout, setCallout]         = useState<Callout | null>(null)
  const [frenzyActive, setFrenzyActive] = useState(false)
  const [slowActive, setSlowActive]   = useState(false)
  const [leaderboard, setLeaderboard]   = useState<LeaderboardEntry[]>([])
  const [playerName, setPlayerName]     = useState("")
  const [submitted, setSubmitted]       = useState(false)
  const [submitting, setSubmitting]     = useState(false)
  const [submitError, setSubmitError]   = useState("")
  const [toast, setToast]               = useState(false)
  const [jigglingEgg, setJigglingEgg]   = useState<number | null>(null)

  useEffect(() => {
    const saved = parseInt(localStorage.getItem(HS_KEY) || "0")
    if (saved > 0) setHighScore(saved)
    fetchLeaderboard().then(setLeaderboard).catch(() => {})
  }, [])

  // Stable callout trigger (setCallout is stable, calloutTimerRef is a ref)
  const triggerCallout = useCallback((text: string, type: "milestone" | "frenzy") => {
    if (calloutTimerRef.current) clearTimeout(calloutTimerRef.current)
    setCallout({ id: Date.now(), text, type })
    calloutTimerRef.current = setTimeout(() => setCallout(null), 1800)
  }, [])

  const handleSubmitScore = useCallback(async () => {
    if (!playerName.trim() || submitting) return
    setSubmitting(true)
    setSubmitError("")
    try {
      await submitScore(playerName, score, gameTime)
      setSubmitted(true)
      setToast(true)
      setTimeout(() => setToast(false), 2500)
      const updated = await fetchLeaderboard()
      setLeaderboard(updated)
    } catch (e: any) {
      setSubmitError(e?.message ?? "Failed to submit")
      console.error("Leaderboard submit error:", e)
    }
    finally { setSubmitting(false) }
  }, [playerName, score, gameTime, submitting])

  // ── Spawn ──────────────────────────────────────────────────────────────────
  const spawnFruit = useCallback((canvas: HTMLCanvasElement) => {
    const diff    = getDifficulty(gameTimeRef.current)
    const isFrenzy = frenzyEndTimeRef.current > 0
    const isCandy  = Math.random() < diff.candyChance
    const roll     = Math.random()
    const isPowerup = !isCandy && roll < POWERUP_CHANCE
    const isShiny   = !isCandy && !isPowerup && roll < POWERUP_CHANCE + SHINY_CHANCE
    const speed     = diff.speed * (0.8 + Math.random() * 0.4) * (isFrenzy ? 1.3 : 1)
    const spawnSz   = isCandy ? EMOJI_SIZE : EGG_SIZE

    let imageSrc: string | null = null
    let emoji = ""
    if (isCandy) {
      emoji = CANDIES[Math.floor(Math.random() * CANDIES.length)]
    } else {
      const colorName = isPowerup
        ? "blue"  // power-ups always use the blue egg base
        : ALL_EGG_COLORS[Math.floor(Math.random() * ALL_EGG_COLORS.length)]
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
      isCandy, isShiny, isPowerup,
    })
  }, [])

  // ── Main loop ──────────────────────────────────────────────────────────────
  const runLoop = useCallback((ts: number) => {
    const video  = videoRef.current
    const canvas = canvasRef.current
    const ctx    = canvas?.getContext("2d")
    if (!video || !canvas || !ctx || !detectorRef.current) {
      rafRef.current = requestAnimationFrame(runLoop); return
    }

    const dt = lastTimeRef.current ? Math.min((ts - lastTimeRef.current) / 1000, 0.05) : 0.016
    lastTimeRef.current = ts
    const dpr = window.devicePixelRatio || 1
    const W = video.videoWidth  || 640
    const H = video.videoHeight || 480
    canvas.width  = W * dpr
    canvas.height = H * dpr
    ctx.scale(dpr, dpr)

    ctx.save(); ctx.scale(-1, 1); ctx.drawImage(video, -W, 0, W, H); ctx.restore()

    const result = detectorRef.current.detectForVideo(video, ts)
    let mouthOpen = false, mouthX = W / 2, mouthY = H * 0.65

    if (result.faceLandmarks?.length > 0) {
      const lms      = result.faceLandmarks[0]
      const mirrored = lms.map((l: any) => ({ x: 1 - l.x, y: l.y }))
      const info     = getMouthInfo(mirrored, W, H)
      mouthX = info.cx; mouthY = info.cy
      mouthOpen = info.ratio > MOUTH_OPEN_RATIO

      ctx.beginPath()
      ctx.arc(mouthX, mouthY, CATCH_RADIUS, 0, Math.PI * 2)
      ctx.strokeStyle = mouthOpen ? "rgba(74,222,128,0.85)" : "rgba(255,255,255,0.35)"
      ctx.lineWidth   = mouthOpen ? 3 : 1.5
      ctx.setLineDash(mouthOpen ? [] : [6, 4])
      ctx.stroke(); ctx.setLineDash([])
      if (mouthOpen) {
        ctx.beginPath(); ctx.arc(mouthX, mouthY, 6, 0, Math.PI * 2)
        ctx.fillStyle = "rgba(74,222,128,0.9)"; ctx.fill()
      }
    }

    if (gameStateRef.current === "playing") {
      gameTimeRef.current += dt
      timeLeftRef.current = Math.max(0, timeLeftRef.current - dt)
      const elapsed = gameTimeRef.current
      setGameTime(Math.floor(elapsed))
      setTimeLeft(Math.ceil(timeLeftRef.current))

      // ── Time up ──────────────────────────────────────────────────────────
      if (timeLeftRef.current <= 0) {
        gameStateRef.current = "gameover"; setGameState("gameover"); setFrenzyActive(false); setSlowActive(false)
        const final = scoreRef.current
        const prev  = parseInt(localStorage.getItem(HS_KEY) || "0")
        if (final > prev) { localStorage.setItem(HS_KEY, String(final)); setHighScore(final) }
        rafRef.current = requestAnimationFrame(runLoop); return
      }

      // ── Milestone callouts ───────────────────────────────────────────────
      for (const m of MILESTONES) {
        if (Math.floor(elapsed) >= m && !milestonesShownRef.current.has(m)) {
          milestonesShownRef.current.add(m)
          const label = m >= 120 ? `${m / 60} MINUTES! 🔥`
                      : m === 60 ? "ONE MINUTE! 🎉"
                      : `${m} SECONDS!`
          triggerCallout(label, "milestone")
        }
      }

      // ── Frenzy trigger ───────────────────────────────────────────────────
      if (elapsed >= nextFrenzyTimeRef.current && frenzyEndTimeRef.current === 0) {
        frenzyEndTimeRef.current = elapsed + FRENZY_DURATION
        nextFrenzyTimeRef.current = elapsed + FRENZY_INTERVAL
        setFrenzyActive(true)
        triggerCallout("FRENZY! 🔥", "frenzy")
        if (audioCtxRef.current) playFrenzySound(audioCtxRef.current)
      }
      if (frenzyEndTimeRef.current > 0 && elapsed >= frenzyEndTimeRef.current) {
        frenzyEndTimeRef.current = 0; setFrenzyActive(false)
      }

      // ── Slow end ─────────────────────────────────────────────────────────
      if (slowEndTimeRef.current > 0 && elapsed >= slowEndTimeRef.current) {
        slowEndTimeRef.current = 0; setSlowActive(false)
      }

      const isFrenzy  = frenzyEndTimeRef.current > 0
      const isSlow    = slowEndTimeRef.current > 0
      const slowFactor = isSlow ? SLOW_MULT : 1
      const diff       = getDifficulty(elapsed)

      // ── Spawn ─────────────────────────────────────────────────────────────
      spawnCoolRef.current -= dt
      const maxF  = isFrenzy ? diff.maxFruits * 2 : diff.maxFruits
      const active = fruitsRef.current.filter(f => !f.eaten && f.y < H).length
      if (active < maxF && spawnCoolRef.current <= 0) {
        spawnFruit(canvas)
        const coolBase = isFrenzy ? diff.spawnCool * 0.4 : diff.spawnCool
        spawnCoolRef.current = coolBase * (0.7 + Math.random() * 0.6)
      }

      fruitsRef.current = fruitsRef.current.filter(f => f.y < H + 80 || f.eatAnim > 0)

      for (const fruit of fruitsRef.current) {
        const size = fruit.imageSrc ? EGG_SIZE : EMOJI_SIZE

        if (!fruit.eaten) {
          fruit.y      += fruit.speed * dt * 60 * slowFactor
          fruit.wobble += dt * 1.2 * slowFactor
          const fx = fruit.x + Math.sin(fruit.wobble) * fruit.wobbleAmp
          const dist = Math.sqrt((fx - mouthX) ** 2 + (fruit.y - mouthY) ** 2)

          if (dist < CATCH_RADIUS && mouthOpen) {
            fruit.eaten = true; fruit.eatAnim = 1
            const audio = audioCtxRef.current
            if (audio) {
              if (fruit.isPowerup)     playPowerup(audio)
              else if (fruit.isShiny)  playShinyCatch(audio)
              else if (!fruit.isCandy) playChomp(audio)
              else                     playBlah(audio)
            }

            if (fruit.isCandy) {
              livesRef.current -= 1
              setLives(livesRef.current)
              setLifeFlash(true)
              setTimeout(() => setLifeFlash(false), 350)
              if (livesRef.current <= 0) {
                gameStateRef.current = "gameover"; setGameState("gameover"); setFrenzyActive(false); setSlowActive(false)
                const final = scoreRef.current
                const prev  = parseInt(localStorage.getItem(HS_KEY) || "0")
                if (final > prev) { localStorage.setItem(HS_KEY, String(final)); setHighScore(final) }
              }
            } else if (fruit.isPowerup) {
              slowEndTimeRef.current = elapsed + SLOW_DURATION
              setSlowActive(true)
            } else if (fruit.isShiny) {
              // Golden egg: add time instead of points
              timeLeftRef.current += SHINY_TIME
              setTimeLeft(Math.ceil(timeLeftRef.current))
              const popupId = nextFruitId.current++
              setScorePopups(prev => [...prev, { id: popupId, label: `+${SHINY_TIME}s`, isTime: true }])
              setTimeout(() => setScorePopups(prev => prev.filter(p => p.id !== popupId)), 900)
            } else {
              const pts = isFrenzy ? 2 : 1
              scoreRef.current += pts; setScore(scoreRef.current)
              // Check 50-pt time bonus milestone
              const tier = Math.floor(scoreRef.current / SCORE_TIME_THRESHOLD)
              if (tier > lastScoreMilestone.current) {
                lastScoreMilestone.current = tier
                timeLeftRef.current += SCORE_TIME_BONUS
                setTimeLeft(Math.ceil(timeLeftRef.current))
                triggerCallout(`+${SCORE_TIME_BONUS}s! ⏰`, "milestone")
                if (audioCtxRef.current) playShinyCatch(audioCtxRef.current)
                const popupId = nextFruitId.current++
                setScorePopups(prev => [...prev, { id: popupId, label: `+${SCORE_TIME_BONUS}s`, isTime: true }])
                setTimeout(() => setScorePopups(prev => prev.filter(p => p.id !== popupId)), 900)
              } else {
                const popupId = nextFruitId.current++
                setScorePopups(prev => [...prev, { id: popupId, label: `+${pts}` }])
                setTimeout(() => setScorePopups(prev => prev.filter(p => p.id !== popupId)), 800)
              }
            }

          } else {
            // Draw
            ctx.save()
            if (fruit.isPowerup) {
              ctx.shadowColor = "rgba(34,211,238,0.95)"; ctx.shadowBlur = 26
            } else if (fruit.isShiny) {
              ctx.shadowColor = "rgba(255,215,0,0.95)"; ctx.shadowBlur = 24
            } else {
              ctx.shadowColor = "rgba(0,0,0,0.4)"; ctx.shadowBlur = 10
            }
            if (fruit.imageSrc) {
              const img = imgCacheRef.current.get(fruit.imageSrc)
              if (img) ctx.drawImage(img, fx - size / 2, fruit.y - size / 2, size, size)
            } else {
              ctx.font = `${size}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"
              ctx.fillText(fruit.emoji, fx, fruit.y)
            }
            ctx.restore()

            // Orbiting sparkles
            if (fruit.isShiny || fruit.isPowerup) {
              const sparkColor = fruit.isPowerup ? "rgba(34,211,238,1)" : "rgba(255,215,0,1)"
              const glowColor  = fruit.isPowerup ? "rgba(34,211,238,0.9)" : "rgba(255,215,0,0.9)"
              for (let i = 0; i < 4; i++) {
                const angle = fruit.wobble * 2.5 + (i / 4) * Math.PI * 2
                ctx.save()
                ctx.beginPath()
                ctx.arc(fx + Math.cos(angle) * size * 0.7, fruit.y + Math.sin(angle) * size * 0.7, 4, 0, Math.PI * 2)
                ctx.fillStyle = sparkColor; ctx.shadowColor = glowColor; ctx.shadowBlur = 8
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
            ctx.font = `${size}px serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"
            ctx.fillText(fruit.emoji, 0, 0)
          }
          ctx.globalAlpha = 1; ctx.restore()

          if (fruit.eatAnim > 0.3) {
            const sc = fruit.isCandy   ? `rgba(248,113,113,${fruit.eatAnim})`
                     : fruit.isPowerup ? `rgba(34,211,238,${fruit.eatAnim})`
                     : fruit.isShiny   ? `rgba(255,215,0,${fruit.eatAnim})`
                     : `rgba(255,220,50,${fruit.eatAnim})`
            const count  = (fruit.isShiny || fruit.isPowerup) ? 10 : 6
            const radius = (1 - fruit.eatAnim) * ((fruit.isShiny || fruit.isPowerup) ? 70 : 50)
            for (let i = 0; i < count; i++) {
              const a = (i / count) * Math.PI * 2
              ctx.beginPath()
              ctx.arc(fruit.x + Math.cos(a) * radius, fruit.y + Math.sin(a) * radius,
                      ((fruit.isShiny || fruit.isPowerup) ? 6 : 4) * fruit.eatAnim, 0, Math.PI * 2)
              ctx.fillStyle = sc; ctx.fill()
            }
          }
        }
      }
    }

    rafRef.current = requestAnimationFrame(runLoop)
  }, [spawnFruit, triggerCallout])

  // ── Camera + image preload ─────────────────────────────────────────────────
  const initCamera = useCallback(async () => {
    setLoadingModel(true)
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const cache = imgCacheRef.current
      await Promise.all(ALL_EGG_SRCS.map(src => new Promise<void>(resolve => {
        if (cache.has(src)) { resolve(); return }
        const img = new Image()
        img.onload = () => { cache.set(src, img); resolve() }; img.onerror = () => resolve(); img.src = src
      })))
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
    } catch (e) { console.error(e); setLoadingModel(false) }
  }, [runLoop])

  // ── Start game ─────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    fruitsRef.current = []; setScorePopups([])
    livesRef.current = 3; scoreRef.current = 0; gameTimeRef.current = 0
    timeLeftRef.current = START_TIME; lastScoreMilestone.current = 0
    spawnCoolRef.current = 0; lastTimeRef.current = 0; nextFruitId.current = 0
    milestonesShownRef.current = new Set()
    slowEndTimeRef.current = 0; frenzyEndTimeRef.current = 0
    nextFrenzyTimeRef.current = FRENZY_INTERVAL
    if (calloutTimerRef.current) clearTimeout(calloutTimerRef.current)
    setLives(3); setScore(0); setGameTime(0); setTimeLeft(START_TIME)
    setCallout(null); setFrenzyActive(false); setSlowActive(false)
    setSubmitted(false); setPlayerName(""); setSubmitError(""); setToast(false)
    setCountdown(3); setGameState("countdown"); gameStateRef.current = "countdown"
    let count = 3
    const tick = setInterval(() => {
      count -= 1; setCountdown(count)
      if (count <= 0) { clearInterval(tick); setGameState("playing"); gameStateRef.current = "playing" }
    }, 1000)
  }, [])

  const exitToStart = useCallback(() => {
    fruitsRef.current = []; gameStateRef.current = "idle"; setGameState("idle")
    setFrenzyActive(false); setSlowActive(false); setCallout(null)
  }, [])

  const exitGame = useCallback(() => {
    fruitsRef.current = []; gameStateRef.current = "idle"
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null
    setCameraReady(false); setGameState("idle"); setFrenzyActive(false); setSlowActive(false)
  }, [])

  useEffect(() => {
    return () => { cancelAnimationFrame(rafRef.current); streamRef.current?.getTracks().forEach(t => t.stop()) }
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-slate-950 overflow-hidden select-none" style={{ fontFamily: "var(--font-nunito)" }}>
      <div className="relative flex-1 min-h-0 flex items-center justify-center">
        <video ref={videoRef} className="absolute opacity-0 pointer-events-none" muted playsInline />
        <canvas ref={canvasRef} className="h-full w-full object-contain" />

        {/* ── Frenzy border pulse ──────────────────────────────────────────── */}
        <AnimatePresence>
          {frenzyActive && (
            <motion.div
              className="absolute inset-0 pointer-events-none z-10"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.3, 0.8, 0.3] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, repeat: Infinity }}
              style={{ boxShadow: "inset 0 0 50px rgba(236,72,153,0.7)" }}
            />
          )}
        </AnimatePresence>


        {/* ── Milestone / Frenzy callout ───────────────────────────────────── */}
        <AnimatePresence>
          {callout && (
            <motion.div
              key={callout.id}
              className="absolute inset-0 flex items-center justify-center pointer-events-none z-25"
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: [0, 1, 1, 0], scale: [0.4, 1.15, 1.05, 1.05] }}
              transition={{ duration: 1.6, times: [0, 0.15, 0.3, 1] }}
            >
              <span
                className="font-black text-center px-6 drop-shadow-2xl"
                style={{
                  fontSize: callout.type === "frenzy" ? 88 : 60,
                  fontFamily: "var(--font-nunito)",
                  color: callout.type === "frenzy" ? "#f472b6" : "white",
                  textShadow: callout.type === "frenzy"
                    ? "0 0 40px rgba(244,114,182,0.95), 0 0 80px rgba(244,114,182,0.5)"
                    : "0 0 30px rgba(255,255,255,0.7), 0 2px 8px rgba(0,0,0,0.8)",
                }}
              >
                {callout.text}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── HUD ─────────────────────────────────────────────────────────── */}
        {gameState === "playing" && (
          <>
            {/* Timer — top center */}
            <div className="absolute top-0 inset-x-0 z-10 flex flex-col items-center pt-3 pointer-events-none transition-colors duration-300">
              <div className="flex items-center gap-1.5">
                <Timer className="w-5 h-5" style={{ color: timeLeft <= 10 ? "#f87171" : timeLeft <= 20 ? "#fb923c" : "white" }} />
                <span
                  className="text-2xl font-black tabular-nums leading-none transition-colors duration-300"
                  style={{ color: timeLeft <= 10 ? "#f87171" : timeLeft <= 20 ? "#fb923c" : "white" }}
                >
                  {timeLeft}s
                </span>
              </div>
              {frenzyActive && <span className="text-xs font-bold text-pink-300 uppercase tracking-widest mt-0.5">2× frenzy</span>}
              {slowActive && !frenzyActive && <span className="text-xs font-bold text-cyan-300 uppercase tracking-widest mt-0.5">🐢 slow</span>}
            </div>

            {/* Score + hearts — bottom */}
            <div className="absolute bottom-5 inset-x-0 z-10 flex justify-center pointer-events-none">
              <div className="flex items-center gap-0 rounded-2xl overflow-hidden" style={{ background: "rgba(60,0,100,0.75)", backdropFilter: "blur(8px)", border: "1px solid rgba(168,85,247,0.3)" }}>
                <div className="flex gap-1 px-5 py-3">
                  {[0, 1, 2].map(i => (
                    <span key={i} className={`text-2xl transition-all ${i < lives ? "opacity-100" : "opacity-20 grayscale"}`}>❤️</span>
                  ))}
                </div>
                <div className="w-px self-stretch bg-white/20" />
                <span className="text-4xl font-black text-white tabular-nums px-5 py-3">{score}</span>
              </div>
            </div>
          </>
        )}

        {/* ── Score popups ─────────────────────────────────────────────────── */}
        <AnimatePresence>
          {scorePopups.map(popup => (
            <motion.div
              key={popup.id}
              className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"
              initial={{ opacity: 1, y: 0, scale: 0.7 }}
              animate={{ opacity: 0, y: -100, scale: 1.3 }}
              transition={{ duration: popup.isTime ? 1.0 : 0.75, ease: "easeOut" }}
            >
              <span
                className="font-black leading-none"
                style={{
                  fontSize: popup.isTime ? 110 : popup.label === "+2" ? 96 : 96,
                  fontFamily: "var(--font-nunito)",
                  color: popup.isTime ? "#34d399" : "#4ade80",
                  textShadow: popup.isTime
                    ? "0 0 40px rgba(52,211,153,0.95), 0 0 80px rgba(52,211,153,0.5)"
                    : "0 0 32px rgba(74,222,128,0.9)",
                }}
              >
                {popup.label}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* ── Toast ───────────────────────────────────────────────────────── */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: -16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              className="absolute top-5 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-full bg-green-500 text-white text-sm font-bold shadow-lg pointer-events-none"
            >
              ✓ Score submitted!
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Floating Exit ────────────────────────────────────────────────── */}
        {cameraReady && gameState !== "idle" && (
          <button onClick={exitToStart}
            className="absolute top-4 right-4 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/40 hover:bg-black/70 text-white text-sm font-medium transition-all backdrop-blur-sm border border-white/20">
            <LogOut className="w-3.5 h-3.5" />Exit
          </button>
        )}

        {/* ── Start screen ─────────────────────────────────────────────────── */}
        {!cameraReady && !loadingModel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-pink-950 via-purple-950 to-sky-950" />
            <div className="absolute inset-0 opacity-[0.15]" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`, backgroundRepeat: "repeat", backgroundSize: "128px 128px" }} />
            <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
              <div className="flex items-center gap-3">
                {["/eggs/egg-yellow-0.svg", "/eggs/egg-pink-0.svg", "/eggs/egg-blue-0.svg"].map((src, i) => (
                  <img key={i} src={src} alt="" style={{ cursor: "pointer" }}
                    className={`w-16 h-16 ${jigglingEgg === i ? "egg-jiggle" : ""}`}
                    onMouseEnter={() => {
                      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
                      playSqueak(audioCtxRef.current)
                      setJigglingEgg(i)
                      setTimeout(() => setJigglingEgg(null), 450)
                    }}
                  />
                ))}
              </div>
              <div className="text-center">
                <h1 className="text-7xl text-white mb-3 tracking-tight text-center" style={{ fontFamily: "var(--font-erica-one)" }}>
                  Easter <span className="text-pink-400">Frenzy</span>
                </h1>
                <p className="text-white text-lg max-w-sm mx-auto text-center">
                  Eat the eggs - avoid the fruit!
                </p>
                {highScore > 0 && <p className="text-yellow-400 text-base font-bold mt-2">🏆 Your best: {highScore}</p>}
              </div>
              <button onClick={initCamera}
                className="mt-4 flex items-center gap-2 px-8 py-4 rounded-2xl bg-pink-500 hover:bg-pink-400 active:scale-95 text-white font-bold text-lg transition-all shadow-lg shadow-pink-900/50 hover:scale-105">
                <Camera className="w-5 h-5" />Start Camera
              </button>
              <p className="text-white/40 text-xs max-w-xs text-center leading-relaxed">
                All processing happens locally in your browser. No video is stored or sent anywhere.
              </p>
              {leaderboard.length > 0 && (
                <>
                  <div className="w-80 border-t border-white/15 pt-1" />
                  <div className="w-80 rounded-xl overflow-hidden" style={{ background: "rgba(60,0,100,0.75)", backdropFilter: "blur(8px)", border: "1px solid rgba(168,85,247,0.3)" }}>
                    <p className="text-purple-300/80 text-sm font-bold uppercase tracking-widest text-center py-3 border-b border-purple-500/20">Top Scores</p>
                    <div className="relative">
                      <div className="max-h-48 overflow-y-auto">
                        {leaderboard.map((entry, i) => (
                          <div key={entry.id} className={`flex items-center justify-between px-4 py-2.5 text-base ${i === 0 ? "bg-yellow-400/10" : ""}`}>
                            <span className={`w-6 font-bold ${i === 0 ? "text-yellow-400" : "text-purple-300/50"}`}>{i + 1}</span>
                            <span className="text-white flex-1 truncate mx-3">{entry.name}</span>
                            <span className="text-purple-200 font-bold tabular-nums">{entry.score}</span>
                          </div>
                        ))}
                      </div>
                      <div className="absolute bottom-0 inset-x-0 h-8 pointer-events-none" style={{ background: "linear-gradient(to bottom, transparent, rgba(60,0,100,0.9))" }} />
                    </div>
                  </div>
                </>
              )}
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
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 bg-black/60">
            <div className="text-center flex flex-col gap-2">
              <h2 className="text-5xl text-white" style={{ fontFamily: "var(--font-erica-one)" }}>Ready?</h2>
              <p className="text-white/70 text-lg">90 seconds / 3 lives</p>
              {highScore > 0 && <p className="text-yellow-400 text-base font-bold">🏆 Your best: {highScore}</p>}
            </div>
            <div className="flex flex-col items-center gap-4">
              <button onClick={startGame}
                className="px-12 py-4 rounded-xl bg-pink-500 hover:bg-pink-400 text-white font-bold text-xl transition-colors">
                Play!
              </button>
              <button onClick={exitGame}
                className="flex items-center gap-1.5 text-white/60 hover:text-white text-base transition-colors">
                <LogOut className="w-3.5 h-3.5" />Exit game
              </button>
            </div>
          </div>
        )}

        {/* ── Countdown ─────────────────────────────────────────────────────── */}
        {gameState === "countdown" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60 pointer-events-none">
            <p className="text-white text-2xl font-black uppercase tracking-widest">Get ready to chomp in...</p>
            <span key={countdown} className="text-[120px] font-black text-white drop-shadow-lg animate-ping"
              style={{ animationDuration: "0.9s", animationIterationCount: 1 }}>
              {countdown === 0 ? "GO!" : countdown}
            </span>
          </div>
        )}

        {/* ── Game Over ─────────────────────────────────────────────────────── */}
        {gameState === "gameover" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center overflow-y-auto" style={{ background: "linear-gradient(135deg, rgba(131,24,67,0.92) 0%, rgba(88,28,135,0.92) 50%, rgba(12,74,110,0.92) 100%)" }}>
            <div className="flex flex-col items-center gap-6 px-6 py-8 w-full max-w-sm">

              {/* Score block */}
              <div className="text-center">
                <p className="text-4xl mb-1">💔</p>
                <p className="text-white text-2xl font-black uppercase tracking-widest mb-3">Game Over</p>
                <p className="text-8xl font-black text-white tabular-nums leading-none">{score}</p>
                {score > 0 && score >= highScore && (
                  <p className="text-yellow-400 text-sm font-bold mt-2">🏆 New high score!</p>
                )}
                <p className="text-white text-sm mt-2">
                  Survived {gameTime} Seconds{highScore > 0 ? ` / Best score: ${highScore}` : ""}
                </p>
              </div>

              {/* Submit + leaderboard block */}
              <div className="w-full flex flex-col items-center gap-3">
                {!submitted ? (
                  <div className="flex gap-2 w-full">
                    <input
                      value={playerName}
                      onChange={e => setPlayerName(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleSubmitScore()}
                      placeholder="Your name"
                      maxLength={20}
                      className="flex-1 px-3 py-2.5 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/40 text-sm outline-none focus:border-pink-400"
                    />
                    <button onClick={handleSubmitScore} disabled={!playerName.trim() || submitting}
                      className="px-5 py-2.5 rounded-xl bg-pink-500 hover:bg-pink-400 disabled:opacity-40 text-white font-bold text-sm transition-colors whitespace-nowrap">
                      {submitting ? "…" : "Submit"}
                    </button>
                  </div>
                ) : null}
                {submitError && <p className="text-red-400 text-xs text-center">{submitError}</p>}

                {leaderboard.length > 0 && (
                  <>
                    <div className="w-full border-t border-white/15 pt-1" />
                    <div className="w-full rounded-xl overflow-hidden" style={{ background: "rgba(60,0,100,0.75)", backdropFilter: "blur(8px)", border: "1px solid rgba(168,85,247,0.3)" }}>
                      <p className="text-purple-300/80 text-sm font-bold uppercase tracking-widest text-center py-3 border-b border-purple-500/20">Top Scores</p>
                      <div className="relative">
                        <div className="max-h-48 overflow-y-auto">
                          {leaderboard.map((entry, i) => (
                            <div key={entry.id} className={`flex items-center justify-between px-4 py-2.5 text-base ${i === 0 ? "bg-yellow-400/10" : ""}`}>
                              <span className={`w-6 font-bold ${i === 0 ? "text-yellow-400" : "text-purple-300/50"}`}>{i + 1}</span>
                              <span className="text-white flex-1 truncate mx-3">{entry.name}</span>
                              <span className="text-purple-200 font-bold tabular-nums">{entry.score}</span>
                            </div>
                          ))}
                        </div>
                        <div className="absolute bottom-0 inset-x-0 h-8 pointer-events-none" style={{ background: "linear-gradient(to bottom, transparent, rgba(60,0,100,0.9))" }} />
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Actions */}
              <div className="flex gap-3 w-full mt-4">
                <button onClick={startGame}
                  className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-pink-500 hover:bg-pink-400 text-white font-bold text-base transition-colors">
                  <RefreshCw className="w-4 h-4" />Try Again
                </button>
                <button onClick={exitToStart}
                  className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium transition-colors text-base">
                  <LogOut className="w-4 h-4" />Menu
                </button>
              </div>

            </div>
          </div>
        )}
      </div>

      {cameraReady && gameState !== "playing" && gameState !== "countdown" && (
        <div className="shrink-0 flex items-center justify-center gap-2 py-2 bg-slate-900 border-t border-slate-800">
          <div className="w-2 h-2 rounded-full bg-pink-500 animate-pulse" />
          <span className="text-xs text-slate-500">Camera active · Face data stays local</span>
        </div>
      )}
    </div>
  )
}
