import { createClient } from "@supabase/supabase-js"

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(url, key)

export interface LeaderboardEntry {
  id: string
  name: string
  score: number
  survived_seconds: number
  created_at: string
}

export async function submitScore(name: string, score: number, survivedSeconds: number) {
  const { error } = await supabase
    .from("leaderboard")
    .insert({ name: name.trim().slice(0, 20), score, survived_seconds: survivedSeconds })
  if (error) throw error
}

export async function fetchLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase
    .from("leaderboard")
    .select("*")
    .order("score", { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}
