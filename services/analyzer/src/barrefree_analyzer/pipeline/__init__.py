"""The analysis pipeline: decode → (separate) → beats → key → chords → (notes).

Each step sits behind a small interface (see ``interfaces``) so implementations can be compared
and swapped: Chordino or BTC for chords, beat_this or librosa for beats, and so on.
"""
