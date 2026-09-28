# Visual directions

The **Look & feel** switcher compares three IMD-inspired directions and the original workspace. Each works with the independent light/dark toggle. The reference was [imd.fun](https://imd.fun/), inspected on 2026-09-28: square controls, monospaced labels, equipment panels and green indicators. This is an independent community prototype, not an official IMD interface.

| Direction | Treatment | Preview query |
| --- | --- | --- |
| Control room | Neutral instrument panels, green accents, original SVG equipment drawing. | `?look=control&theme=dark#hosts` |
| Paper ledger | Warm paper surfaces, strong typography and horizontal comparison rows on larger screens. | `?look=ledger&theme=light#hosts` |
| Terminal | Green console palette, monospace typography and a static terminal illustration. Default for a fresh browser. | `?look=terminal&theme=dark#hosts` |
| Original | The previous blue workspace, retained for comparison. | `?look=original&theme=light#hosts` |

Append a query to the local preview address printed by `node server.mjs`. Query parameters override saved appearance preferences for that page. Selecting a look saves it locally and updates the link. A theme supplied in the link updates when the theme toggle is used. With no query parameters, saved preferences apply; a fresh browser starts in dark Terminal.

The treatments apply to the directory, agreements, guide and dialogs. They share the same model and local demo data. Switching appearance neither changes agreement terms nor resets the saved simulation. Preferences use separate storage keys; the schema remains v4.

The artwork is inline SVG, the fonts are local system fallbacks, and there are no added dependencies, external font requests, animation loops or audio. The instruments are decorative and do not report live service activity.

## Validation, 2026-09-28

- JavaScript syntax check and all 53 existing model/server tests passed.
- Browser checks covered the three new desktop treatments, four looks in light/dark at 390 px, filters, a provider profile, the listing form and an existing agreement. Mobile tables scroll inside their panels.
- A Paper ledger mobile grid overflow found during the checks was fixed and rechecked.
- Appearance selection and the agreement survived reload. No browser console errors or warnings were observed during these checks.
- No model, server, wallet, contract or live worker changes. These checks are UI smoke checks, not a full accessibility audit or production certification.
