const BEST_KEY = 'mondrian.best'
const RUNS_KEY = 'mondrian.runs'

const read = (key: string) => {
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}

const write = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // private mode / blocked storage: best score simply won't persist
  }
}

export const getBest = () => read(BEST_KEY)
export const setBest = (score: number) => write(BEST_KEY, score)
export const nextRunNumber = () => {
  const n = read(RUNS_KEY) + 1
  write(RUNS_KEY, n)
  return n
}
