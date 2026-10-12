/**
 * Chooses one voicing per chord symbol, trading individual cost against the number of
 * different shapes to learn:
 *
 *   minimize  Σ_s w_s · cost(s, v_s)  +  μ · |{ v_s }|
 *
 * This is an uncapacitated facility-location problem (Cornuéjols, Nemhauser & Wolsey, 1990):
 * NP-hard in general, but songs have only a handful of distinct chords, so exact
 * branch-and-bound after pruning is instant. The search is anytime: each component starts from
 * the greedy solution and, if its node limit is hit, keeps the best solution found so far.
 */

export interface Candidate {
  /** Shape identity (voicing id); equal ids count as one shape. */
  id: string
  cost: number
}

export interface AssignmentProblem {
  /** Weight of each symbol (> 0). */
  weights: readonly number[]
  /** Candidates per symbol, in preference order (ties are resolved by this order). */
  candidates: readonly (readonly Candidate[])[]
  /** Cost of each distinct shape used. */
  mu: number
}

export interface AssignmentSolution {
  /** Chosen candidate index per symbol. */
  choice: number[]
  total: number
  /** False if the node limit stopped the search before it proved optimality. */
  exact: boolean
}

const EPS = 1e-12

export function evaluateAssignment(problem: AssignmentProblem, choice: readonly number[]): number {
  const ids = new Set<string>()
  let total = 0
  choice.forEach((c, i) => {
    const cand = problem.candidates[i]?.[c]
    if (!cand) throw new Error(`invalid choice ${c} for symbol ${i}`)
    total += (problem.weights[i] ?? 0) * cand.cost
    ids.add(cand.id)
  })
  return total + problem.mu * ids.size
}

/** Exhaustive search, exponential: only for tests on small instances. */
export function bruteForceAssignment(problem: AssignmentProblem): AssignmentSolution {
  const n = problem.candidates.length
  const choice = new Array<number>(n).fill(0)
  let best: AssignmentSolution = { choice: [...choice], total: Infinity, exact: true }
  const walk = (i: number) => {
    if (i === n) {
      const total = evaluateAssignment(problem, choice)
      if (total < best.total - EPS) best = { choice: [...choice], total, exact: true }
      return
    }
    const list = problem.candidates[i] ?? []
    for (let c = 0; c < list.length; c++) {
      choice[i] = c
      walk(i + 1)
    }
  }
  if (problem.candidates.every((l) => l.length > 0)) walk(0)
  return best
}

/**
 * @param nodeLimit search nodes per independent component
 * @param maxCandidates candidates kept per symbol after exact pruning (cheapest first); a cap
 *   that removes candidates makes the result a heuristic (`exact: false`)
 */
export function solveAssignment(
  problem: AssignmentProblem,
  nodeLimit = 20_000,
  maxCandidates = 10,
): AssignmentSolution {
  const { weights, candidates, mu } = problem
  const n = candidates.length
  if (n === 0) return { choice: [], total: 0, exact: true }
  if (candidates.some((l) => l.length === 0)) {
    return { choice: new Array<number>(n).fill(-1), total: Infinity, exact: true }
  }

  // 1. Pruning. Switching symbol i from its cheapest candidate to v can save at most one shape
  //    (μ), so candidates costing more than that extra can never be part of an optimum.
  const kept: number[][] = candidates.map((list, i) => {
    const w = weights[i] ?? 0
    const best = list.reduce((m, c) => Math.min(m, c.cost), Infinity)
    return list.flatMap((c, k) => (w * (c.cost - best) <= mu + EPS ? [k] : []))
  })
  let exact = true
  for (let i = 0; i < n; i++) {
    const ks = kept[i] ?? []
    if (ks.length > maxCandidates) {
      const list = candidates[i] ?? []
      ks.sort((a, b) => (list[a]?.cost ?? 0) - (list[b]?.cost ?? 0) || a - b)
      kept[i] = ks.slice(0, maxCandidates).sort((a, b) => a - b)
      exact = false
    }
  }

  // 2. Independent components: symbols are linked when they share a candidate shape.
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] ?? i] ?? i
    return i
  }
  const owner = new Map<string, number>()
  kept.forEach((ks, i) => {
    for (const k of ks) {
      const id = candidates[i]?.[k]?.id ?? ''
      const j = owner.get(id)
      if (j === undefined) owner.set(id, i)
      else parent[find(i)] = find(j)
    }
  })
  const components = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const list = components.get(root) ?? []
    list.push(i)
    components.set(root, list)
  }

  // 3. Branch and bound per component, each with its own node budget. The incumbent starts as
  //    the greedy solution, so an interrupted search still returns a sensible assignment.
  const choice = new Array<number>(n).fill(0)
  for (const members of [...components.values()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
    const order = [...members].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a - b)
    const minCost = order.map((i) => {
      const w = weights[i] ?? 0
      return Math.min(...(kept[i] ?? []).map((k) => w * (candidates[i]?.[k]?.cost ?? Infinity)))
    })
    // suffix[d] = lower bound for symbols order[d..]
    const suffix = new Array<number>(order.length + 1).fill(0)
    for (let d = order.length - 1; d >= 0; d--) suffix[d] = (suffix[d + 1] ?? 0) + (minCost[d] ?? 0)

    const opened = new Map<string, number>()
    const optionsAt = (depth: number) => {
      const i = order[depth] ?? 0
      const w = weights[i] ?? 0
      return (kept[i] ?? [])
        .map((k) => {
          const cand = candidates[i]?.[k]
          const id = cand?.id ?? ''
          const marginal = w * (cand?.cost ?? Infinity) + (opened.has(id) ? 0 : mu)
          return { k, id, marginal }
        })
        .sort((a, b) => a.marginal - b.marginal || a.k - b.k)
    }
    const open = (id: string) => opened.set(id, (opened.get(id) ?? 0) + 1)
    const close = (id: string) => {
      const count = (opened.get(id) ?? 1) - 1
      if (count === 0) opened.delete(id)
      else opened.set(id, count)
    }

    // Greedy incumbent: cheapest marginal choice at each step.
    let bestChoice: number[] = []
    let bestTotal = 0
    for (let d = 0; d < order.length; d++) {
      const first = optionsAt(d)[0]
      bestChoice.push(first?.k ?? 0)
      bestTotal += first?.marginal ?? 0
      if (first) open(first.id)
    }
    opened.clear()

    let nodes = 0
    const current: number[] = []
    const dfs = (depth: number, partial: number): void => {
      if (nodes++ > nodeLimit) {
        exact = false
        return
      }
      if (depth === order.length) {
        if (partial < bestTotal - EPS) {
          bestTotal = partial
          bestChoice = [...current]
        }
        return
      }
      for (const { k, id, marginal } of optionsAt(depth)) {
        const next = partial + marginal
        if (next + (suffix[depth + 1] ?? 0) >= bestTotal - EPS) break
        current.push(k)
        open(id)
        dfs(depth + 1, next)
        close(id)
        current.pop()
      }
    }
    dfs(0, 0)
    order.forEach((i, d) => (choice[i] = bestChoice[d] ?? 0))
  }
  return { choice, total: evaluateAssignment(problem, choice), exact }
}
