# Transform engine (`packages/theory`)

The engine turns a chord progression into barre-free guitar voicings. It is pure TypeScript with
no I/O: the same input always gives the same output, and it runs in the browser, so switching
modes is instant. Pasted chord sheets and analyzed audio both go through it.

```
labels ──parse──▶ chords ──weights──▶ symbols ──┬─ for each capo c in the mode's range ─┐
 "F", "A:min7"     (root, interval set, bass)    │  shape = chord transposed by −(c+shift) │
                                                 │  candidates = library ∪ generator      │
                                                 │  cost = difficulty + λ·(1 − fidelity) │
                                                 │  assignment: min Σ w·cost + μ·shapes  │
                                                 └─ total = assignment + κ(c) ───────────┘
                                                                  ▼
                                                rank capos → best + 2 alternatives
```

## 1. Chord model

A chord is `{ root, intervals, bass }`, where `intervals` is a 12-bit set of semitones above
the root.

- Bit 0 is always set.
- `bass` is null for root position and is never equal to the root.

**Why a bitmask?** Each sound then has exactly one representation:

- Transposition only moves `root` and `bass`.
- Equality is integer comparison.
- Simplification clears bits.

The named structure (third, fifth, seventh, sixth, tensions) is derived on demand by
`describe()`. That classification is total and lossless: a test checks all 2048 interval sets.

| Interval | Classified as                                                          |
| -------- | ---------------------------------------------------------------------- |
| 4 / 3    | third: M3 if present, else m3. If both are present, the m3 becomes #9. |
| 5 / 2    | sus4 / sus2 when there is no third; otherwise the 11 / 9 tension       |
| 7, 6, 8  | fifth: P5, else b5, else #5. With a P5 present, 6 is #11 and 8 is b13. |
| 10 / 11  | seventh: b7, else maj7. A 9 is bb7 only in a diminished triad.         |
| 9        | sixth without a seventh, 13 with one                                   |

### Parsing and formatting

**Chord symbols** (`parseChordSymbol` / `formatChordSymbol`) cover what chord sheets use:
`F#m7b5`, `Bb/D`, `Gsus4`, `C6/9`, `Am(maj7)`, `C°7`, `Cø`, `C+`, `D2`, `Cadd9`, `C7(b9,#9)`,
`C(no3)`, and `♯`/`♭` accidentals.

- In pop usage, **`C13` = 7 + 9 + 13**: the 11 is omitted because it clashes with the third.
- The formatter is **total**: every interval set and bass formats to a symbol that parses back
  to the same chord. Tests check this for all 2048 sets and with fast-check for random roots and
  spellings. Uncommon leftovers are written as `add…`/`no3`/`no5`.

**Harte labels** (`parseHarte` / `formatHarte`) follow mir_eval 0.8.2.

- `13` = 7 + {9, 11, 13}, as in `EXTENDED_QUALITY_REDUX`.
- Degree lists, `*` omissions and bass degrees (`G:7/3`) are supported.
- The formatter emits only single-octave shorthands plus extra degrees (`C:7(9)`), so the
  extended shorthands are never ambiguous.

**Key spelling.** `estimateKeySignature` scores the 12 major key signatures:

- +1 per chord whose root is diatonic, +1 more if its triad also matches the scale.
- Ties go to fewer accidentals.

Diatonic notes take the signature's accidental (D# in E major); others use the common chart
spelling (Bb, Eb, F#, C#, Ab).

## 2. Voicing library (`data/voicings`)

**Seed:** tombatossals/chords-db (MIT), pinned to a commit and a SHA-256.

- `scripts/import-chords-db.ts` converts relative frets to absolute and checks each position
  against the MIDI notes chords-db lists.
- It keeps 3083 of 3283 positions. Positions are dropped when their notes contradict their name
  (rootless, third-less, data errors, 13ths that include the 11, two-string power chords).

**Curated set:** `standard/curated.json` holds 36 hand-checked shapes, with the classic
barre-free substitutes (Fmaj7 `xx3210`, Bm7 `x20202`, B7 `x21202`) and slash chords. Curated
entries win over chords-db for identical frets.

**Derived, never stored:** barres, finger count, span, muted and open strings
(`analyzeShape`). A barre is one finger on two or more strings at the same fret:

- **full** when it spans five or six strings;
- **mini** otherwise.

**Fretboard generator:** `generateVoicings` is a fallback for chords the library lacks. It
enumerates 4-fret windows and checks:

- every note is a chord tone;
- the bass is right, and the root and third are present;
- a fingering exists with at most four fingers (a barre is allowed only over fretted strings).

## 3. Difficulty

Weights are integers in hundredths of a point (`DEFAULT_DIFFICULTY`):

```
D(v) = 1.00                                   base
     + 6.00 per full barre | 2.00 per mini barre
     + 0.50 per finger used
     + 1.00 per fret of span beyond 2
     + 0.30 per fret the highest note sits above fret 3 (relative to the capo)
     + 1.50 per muted string between sounding strings
     + 0.50 per muted string above the highest sounding string
     − 0.40 per open string above the lowest sounding string
```

Muted strings on the bass side cost nothing, and an open string counts only above the bass.
**Without this rule**, a wrong-bass inversion such as C/E (`032010`) for C would be cheaper
than the real C (`x32010`), just because it rings one more open string.

## 4. Fidelity

`fidelity(target, played)` returns a value from 0 to 1:

```
fidelity = max(0, 1 − (missing + added + bass) / Σ weights of the target's tones)
```

**Tone weights:**

| Tone                                         | Weight |
| -------------------------------------------- | ------ |
| root                                         | 3      |
| third (or sus tone)                          | 3      |
| fifth                                        | 1      |
| altered fifth, or the fifth of a power chord | 3      |
| seventh / sixth                              | 1.5    |
| highest tension                              | 1      |
| other tensions                               | 0.5    |
| slash bass that is not a chord tone          | 1.5    |

**Penalties for added tones:**

| Added tone                   | Penalty |
| ---------------------------- | ------- |
| seventh                      | 0.8     |
| ninth                        | 0.8     |
| sixth                        | 1       |
| fourth                       | 1       |
| fifth                        | 0.2     |
| third added to a power chord | 0.5     |
| anything else                | 2       |
| **clash**                    | 10      |

A clash is the other third (major ↔ minor, or a third on a sus chord), the other seventh, or
a perfect fifth against an altered one.

**Bass mismatch:** 1.5 if the written slash bass is missing from the bottom, 1.0 if the root is.

**Why a seventh is the cheapest colour.** The textbook substitutes all add a seventh
(F → Fmaj7, Bm → Bm7, B → B7). A shape that adds two colours, such as F6/9 for F, falls below
the easy-mode floor of 0.75. A first calibration used lower penalties (6th 0.6, 9th 0.5), and
easy mode then recoloured chords that needed no help (G → G6/9, C → Cadd9).

**`realizes(target, played)`** is the strict test used by the `original` and `capo` modes.

- Every chord tone must sound, except a perfect fifth and non-highest tensions (C7 `x32310` has
  no G).
- Nothing may be added.
- The lowest note must be the written bass.

### Worked example: four ways to play F (tested in `test/voicings.test.ts`)

| Shape               | Plays       | D(v) | Fidelity            | λ=5      | λ=10 (default) | λ=20     | λ=40     |
| ------------------- | ----------- | ---- | ------------------- | -------- | -------------- | -------- | -------- |
| F barre `133211`    | F C F A C F | 9.00 | 1                   | 9.00     | 9.00           | 9.00     | 9.00     |
| small F `xx3211`    | F A C F     | 4.50 | 1                   | 4.50     | 4.50           | 4.50     | **4.50** |
| Fmaj7 `xx3210`      | F A C E     | 2.10 | 0.886 (+E: 0.8/7)   | **2.67** | **3.24**       | **4.38** | 6.66     |
| 3-string F `xxx211` | A C F       | 4.00 | 0.857 (A bass: 1/7) | 4.71     | 5.43           | 6.86     | 9.72     |

The choice flips from Fmaj7 to the small F at λ ≈ 21.

## 5. Weights, capo and modes

**Symbol weights** (`symbolWeights`):

- **Timed input:** half share of duration, half share of occurrences. Changing to a hard chord
  thirty times is harder than holding it for thirty seconds.
- **Untimed input:** share of occurrences.
- Repeated consecutive chords count once, and no-chord segments are ignored.
- Timed segments shorter than 0.25 s count only by duration.
- Weights sum to 1, so totals do not depend on song length.

**For each capo `c`** (and uniform tuning shift, e.g. −1 for E♭ standard):

1. The shape chord is `transpose(chord, −(c + shift))`.
2. Each candidate gets `cost = D + λ(1 − fidelity)`.
3. Candidates must keep within fret 15 physically.

**Assignment.** Every symbol gets one shape:

```
min Σ_s w_s · cost(s, v_s) + μ · |distinct shapes|      (src/assign.ts)
```

This is uncapacitated facility location (Cornuéjols, Nemhauser & Wolsey 1990). The solver:

1. **Prunes** candidates costing more than `μ / w` above their symbol's best. Such a candidate
   can never be optimal, because switching saves at most one shape.
2. **Splits** the problem into components of symbols that share candidates.
3. **Solves** each component with branch and bound, with a node limit.

Property tests check it against brute force.

**Capo total:** `assignment + κ(c)`, where `κ(c) = 0.1·c + 0.2·max(0, c − 4)²` (a high capo
thins the sound). Totals within 0.05 of the best are ties, and the lowest capo wins them. The
best three are returned, and the UI can request any feasible capo explicitly.

| Mode       | Capos | Constraint                    | Fidelity floor | Min strings | Full barres                | Simplify     | μ   |
| ---------- | ----- | ----------------------------- | -------------- | ----------- | -------------------------- | ------------ | --- |
| `original` | 0     | `realizes`                    | –              | 3           | allowed                    | –            | 0   |
| `capo`     | 0–7   | `realizes`                    | –              | 3           | allowed                    | –            | 0.1 |
| `easy`     | 0–7   | root + third, no clash, floor | 0.75           | 4           | dropped if any alternative | –            | 0.1 |
| `beginner` | 0–7   | root + third, no clash, floor | 0.6            | 3           | dropped if any alternative | drop 9/11/13 | 0.5 |

**The λ slider** has five stops: 2, 5, 10 (default), 20, 40. Choices only change at
breakpoints, so fixed stops keep results and tests stable. At a fixed capo, a higher λ never
lowers the weighted fidelity. This holds for any exact optimizer and is property-tested.

### Acceptance (M1), at λ = 10 in easy mode

| Progression | Chosen                      | Total                   | Runner-up     |
| ----------- | --------------------------- | ----------------------- | ------------- |
| F–C–G–Am    | capo 0: **Fmaj7**, C, G, Am | 2.486 (2.086 + 4 × 0.1) | capo 5: 2.675 |
| Bm–G–D–A    | capo 0: **Bm7**, G, D, A    | 2.586                   | capo 2: 2.686 |

Neither has a full or mini barre. In `capo` mode, F–C–G–Am moves to capo 5 (C–G–D–Em shapes),
where every chord is exact.

## References

- C. Harte, M. Sandler, S. Abdallah, E. Gómez, "Symbolic representation of musical chords: a
  proposed syntax for text annotations", ISMIR 2005.
- C. Raffel et al., "mir_eval: a transparent implementation of common MIR metrics", ISMIR 2014.
  Chord qualities are taken from `mir_eval/chord.py` 0.8.2.
- S. Sayegh, "Fingering for string instruments with the optimum path paradigm", _Computer
  Music Journal_ 13(3), 1989.
- D. Radisavljevic, P. Driessen, "Path difference learning for guitar fingering problem",
  ICMC 2004.
- G. Cornuéjols, G. Nemhauser, L. Wolsey, "The uncapacitated facility location problem", in
  _Discrete Location Theory_, Wiley, 1990.
- tombatossals/chords-db, MIT. Source of the imported voicings.
