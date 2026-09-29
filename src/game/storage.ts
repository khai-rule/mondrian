const BEST_KEY = 'mondrian.best'
const NAME_KEY = 'mondrian.name'
const ENTRY_KEY = 'mondrian.entry'

const get = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const set = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode / blocked storage: values simply won't persist
  }
}

export const getBest = () => Number(get(BEST_KEY)) || 0
export const setBest = (score: number) => set(BEST_KEY, String(score))

export const getName = () => get(NAME_KEY) ?? ''
export const setName = (name: string) => set(NAME_KEY, name)

// The player's best submitted run, so the leaderboard can show where they stand.
export interface MyEntry {
  id: number
  score: number
}

export const getMyEntry = (): MyEntry | null => {
  const raw = get(ENTRY_KEY)
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null && 'id' in value && 'score' in value) {
      if (typeof value.id === 'number' && typeof value.score === 'number') return { id: value.id, score: value.score }
    }
  } catch {
    // corrupt value: treat as no entry
  }
  return null
}

export const setMyEntry = (entry: MyEntry) => set(ENTRY_KEY, JSON.stringify(entry))
