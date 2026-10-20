# Paper Reading research scope

Status: **active since 2026-08-06**
Reviewed: **2026-08-06**

This document is the human-readable companion to `research-config.json` and
`venue-registry.json`. The JSON files are authoritative for automation. The Daily and
Library views use these active directions as their shared topic taxonomy.

## Directions

| Direction | Attention policy | Current boundary |
| --- | --- | --- |
| LEGO | Core project / high recall | Any AI, graphics, or vision contribution centered on LEGO or interlocking-brick models; task is unrestricted. |
| Embroidery | Core project / high recall | AI and graphics for embroidery representation, generation, stitch/path planning, digitization, editing, rendering, or fabrication-ready design. |
| Fabrication | Continuous | Generate fabrication-ready designs, structures, toolpaths, or assembly plans under process or physical constraints; generation must be the main contribution. |
| 2D Design | Continuous | Structured and editable 2D artifacts: SVG, vector, sketch, stroke, layers, decomposition, vectorization, and explicit primitives. |
| 3D Generation | Continuous | Create or edit new 3D objects, parts, scenes, CAD, appearance, and selected dynamic content. |
| 3D Segmentation | Focused | 3D semantic/instance/part/promptable segmentation and only the point/mesh encoders that materially advance it. |
| 3D Reconstruction | Selective | Faithful recovery of a specific object, scene, human, or dynamic input; only paradigm shifts or clearly transferable work. |
| VLM / MLLM | Continuous | Important multimodal foundation models, visual/spatial reasoning, grounding, tokenization, and capabilities transferable to design. |
| Visual Design Agents | Focused | Agents that plan, operate design tools, inspect visual output, and iteratively revise 2D, 3D, CAD, image, video, or fabrication artifacts. |
| Image Generation | Landmark or transfer | Major raster generation/editing advances, or methods directly transferable to core work. |
| Video Generation | Landmark or transfer | Major video generation/editing advances, especially consistency, control, and 3D/4D transfer. |
| LLM | Landmark only | Important foundation models, official reports, and field-changing training or reasoning paradigms. |

There is no daily paper quota. A direction can legitimately have no accepted paper on a
given day.

## Confirmed routing decisions

- LEGO and Embroidery are primary topics whenever either is the real research object. A paper
  may additionally carry the corresponding technical direction.
- Faithful recovery of a specific input is Reconstruction; plausible content creation is
  Generation. A generative prior alone does not decide the label.
- SVG, strokes, layers, vectors, and other editable structures belong to 2D Design; pure
  raster pixels belong to Image Generation.
- Editing follows the artifact and does not receive a separate direction.
- Fabrication requires process, material, assembly, or manufacturability constraints inside
  the method or output. Printing a result as a demo is insufficient.
- Using a VLM does not automatically make a paper VLM/MLLM research. A wrapper around an
  existing model that closes a design loop is primarily a Visual Design Agent.
- Point/mesh representation learning enters 3D Segmentation only when it materially advances
  segmentation or part representation.
- A canonical paper is stored once and can carry multiple topic IDs.

## Explicit exclusions

- Image/Video Restoration, SR, VSR, STVSR, and frame interpolation
- Generic Geometry Processing
- Generic 2D detection, segmentation, recognition, and pose estimation
- Generic web, coding, research, office, and gameplay agents
- Interaction-first fabrication systems and maker user studies
- Textile industry operations, machine mechanics, and material characterization
- vLLM, LLM serving, and unrelated MLSys work

These are scope exclusions, not banned words. A negative term rejects a candidate only when it
describes the paper's main research object or contribution.

## Typed tags

The automation keeps free-form paper keywords, but filtering uses controlled facets:

| Facet | Examples |
| --- | --- |
| Task | Generation, Editing, Completion, Segmentation, Reconstruction, Decomposition, Tool Use |
| Content Scope | Part/Assembly, Object, Scene, Human/Avatar, Environment/World |
| Representation | SVG, Stroke, Layered 2D, 2D Gaussian, Mesh, Point Cloud, 3D Gaussian, NeRF, SDF, CAD/B-Rep |
| Conditioning | Text, Single Image, Multi-view, Video, Sketch/Layout, Partial 3D, Multimodal |
| Method | Diffusion, Autoregressive, Flow Matching, Feed-forward, Optimization/SDS, Program Synthesis, LLM/VLM-guided |
| Prior/Data | Native 3D, 2D Prior, Multi-view Prior, Video Prior, Synthetic Data |
| Output Property | Part-aware, Controllable, Editable, Asset-ready, Animation-ready, Fabrication-aware |

For 3D Generation, `Object` is content scope, `CAD` is representation/domain, and
`Asset-ready` is an output property. They must not be flattened into mutually exclusive tags.

## Venue policy

The registry is a versioned normalization and ranking layer, not a whitelist.

- P0 covers SIGGRAPH/SIGGRAPH Asia/TOG, CVPR/ICCV/ECCV, NeurIPS/ICML/ICLR, and TPAMI.
- P1 adds 3DV, IJCV, Eurographics/CGF, Computer-Aided Design, and ACM SCF.
- P2 covers AAAI, IJCAI, ACM Multimedia, TMM, TIP, TVCG, Pacific Graphics, and
  Computational Visual Media under stricter topic filtering.
- Exact LEGO/Embroidery work, strong preprints, and official landmark technical reports can
  override venue priority.
- SIGGRAPH/TOG and Eurographics/CGF event/publication metadata are retained separately and
  deduplicated through paper identifiers.

## Cross-date library

The `/paper_reading/library/` view answers a different question from the daily
digest: what has been collected across all dates, and how can it be found again?

- Default: a flat deduplicated catalog sorted by immutable collection date.
- Search: title, authors, keywords, venue, and the one-sentence idea.
- Filters: direction, venue, typed facets, code availability, relevance, reading action, and collection date.
- Sort: collection date, publication date, paper update date, or relevance.
- Filter state is shareable through URL parameters.
- The daily digest, cross-date library, and personal reading list remain separate views.

## Activation state

The scope was activated on 2026-08-06: the twelve directions now replace the three demo
topics, canonical records carry identifiers and typed facets, both policy files are active,
and the launch digest includes a brief for every direction. Daily discovery starts from this
launch boundary; earlier dates remain a separate `backfill` workflow.

Direction grouping in the UI is intentionally deferred. Cloud-synced user state, Zotero
archiving, and per-paper AI visuals remain separate implementation decisions.
