# paper.png

A 256×256 seamless paper-tooth overlay (black/white speckles, 0–9% alpha, palette PNG).

- **Source:** "Paper 001" by ambientCG, https://ambientcg.com/a/Paper001 (CC0 1.0, public domain; no attribution required).
- **Used:** the 1K displacement map, native texel size, 256×256 crop.
- **Processing:** high-pass (Gaussian σ=10) so it carries no tone or colour, normalised, made seamless with a
  variance-preserving blend against a half-shifted copy, then encoded as dark/light speckles in 6 alpha steps.
  Mean strength ≈ 3.4 %, peak 9 %. Rebuilt by the Python/Pillow script described here; no colour information is used.
