# Hard offset shadow advisory: verification plan

Fixture: `../antipatterns/hard-offset-shadow.html`. It contains four should-flag
panels and eight should-pass panels, with explicit sizes and distinct headings.

## Automated gates

- `cargo test -p impeccable-core checks::hard_offset_shadow`: positive/negative
  offsets, omitted blur/currentColor, multiple layers, 4px boundary, soft/inset
  shadows, focus rings, transparent/faint paint, negative spread, unresolved
  lengths and invalid colors.
- `cargo test -p impeccable-html --test hard_offset_shadow`: exactly four
  advisory findings; scoped/ancestor and comment waivers, hidden ancestors.
- `cargo test -p impeccable-browser --test hard_offset_shadow`: the same four
  selectors through the installed Chromium browser and native rule core.
- `cargo xtask bundle`, then `cargo build --release -p impeccable`.
- `IMPECCABLE_BIN=target/release/impeccable node tests/oracle/run.mjs detect-hard-offset-shadow`:
  advisory-only CLI output exits 0; `--no-advisory` produces no finding and exits 0.
- Full `cargo test --workspace`, `IMPECCABLE_BIN=target/release/impeccable bun run test`,
  and `bun run build` before ready. Review fixture/directory oracle changes by hand.

## Browser/WASM and extension checks

`node tests/fixtures/hard-offset-shadow/browser-check.mjs` runs the in-page WASM
bundle in Puppeteer Chrome and installed Firefox (set `FIREFOX_PATH` outside the
macOS default). It asserts advisory metadata, repeated scans, and rule disabling
and re-enabling. JSON evidence and fixture screenshots land in `build/929/`.
This checks the real WASM consumer, not the extension popup/DevTools wiring.


Serve `tests/fixtures/antipatterns` locally and open `hard-offset-shadow.html`.
Use the newly bundled detector, not a released version. In both Chrome and Firefox:

1. Scan the fixture. Expect exactly four **hard-offset-shadow** findings on
   `#flag-0` through `#flag-3`; unrelated rule findings should be reviewed separately.
2. Confirm no hard-offset finding on the pass column, including the deliberate
   neobrutalist treatment with `data-impeccable-ignore="hard-offset-shadow"`.
3. Re-scan. Expect the same four, without duplicate overlays.
4. Disable this rule through the extension's DevTools rule settings and rescan.
   Expect zero findings for this rule. Re-enable and expect four again.
5. Confirm the finding text asks whether the effect fits the intended direction,
   without claiming AI authorship or instructing automatic removal.
6. Confirm both popup/DevTools list the new rule. An advisory can be shown in the
   extension's findings/badge; advisory status guarantees CLI failure semantics,
   not invisibility in every UI.

Firefox's offscreen-host compatibility fix is tracked separately in #847. Test
with that patch when exercising the extension rather than just the in-page WASM
bundle. Keep the two PRs independent.

## Limits and calibration before ready

This rule measures resolved outer box shadows with zero blur, nonnegative spread,
alpha after element opacity above 0.1, and an offset of at least 4 CSS pixels on
one axis. The threshold separates the fixture cases; it is not a design standard.
Unresolved lengths/colors and negative spread remain outside this initial rule.
It does not scan text-shadow or raw CSS/JS declarations, infer neobrutalist intent,
or recommend deleting shadows. Static scans cannot establish actual occlusion.

Before enabling this beyond a draft, review real generated-project examples
against their design briefs as well as intentional neobrutalist examples. The
synthetic fixture proves the mechanical rule, not precision on unwanted designs.
Use existing scoped or project ignore mechanisms for intentional uses.
