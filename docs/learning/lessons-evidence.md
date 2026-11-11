# Lessons evidence

One section per rule in [lessons.md](lessons.md): the anchor that proves it, the gate that will retire it, what was believed and what happened instead, and what was tried and abandoned. Entries are corrected in place, with the correction dated, and deleted only when their gate has landed and been proved red.

## Occlusion read the relief normals

Anchor: `SSAO_FS` in `src/render/shaders/post.ts` (2026-11-11), which now rebuilds the face normal from four depth taps.

Gate that will retire it: a browser test that builds a flat wall of birch logs in open air, probes it with `settings.ssao` on and off, and fails if the mean brightness differs by more than a few percent.

What was believed: ambient occlusion could read the normal the G-buffer already holds. What happened: that normal is tilted texel by texel by each tile's painted relief (`chunk.ts` adds the material texture's slope), and a tilted normal sees the flat face it sits on as an occluder. Every dark mark on a birch trunk grew a soft dark halo several pixels wide, which read as the texture being blurred. Bloom and antialiasing were suspected first; captures with each effect off in turn (`scripts/capture.mjs` with a `clip`) showed the halo followed occlusion alone. No test caught it because the browser gate checks coarse probe colours, and a halo that size moves a mean by very little unless the test is aimed at a flat, high-contrast wall.
