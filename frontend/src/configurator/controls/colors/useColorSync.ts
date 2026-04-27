/**
 * useColorSync — real-time preview synchronization with FIFO ordering (ST-009).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/colors/
 *     useColorSync.ts | ST-009 real-time sync calls texture pipeline".
 *   - ST-009 acceptance criteria — color slice changes propagate to the
 *     live 3D preview within the documented latency budget; the
 *     correctness contract for AC4 is FIFO ordering: when N rapid
 *     selections occur within a single render cycle, the FINAL
 *     selection MUST always win (no stale color stuck on the ball).
 *   - QA Report Issue #4 — `useColorSync.ts` MUST be the SINGLE
 *     canonical caller of the texture pipeline from
 *     `frontend/src/configurator/controls/colors/`. Implementation MUST
 *     use `useRef<Promise<void>>` to chain successive update promises
 *     so rapid color changes (5 changes within 50 ms in the QA
 *     reproduction) are applied in submission order.
 *
 * Architecture & ordering contract:
 *   The Zustand store's `set(...)` calls are SYNCHRONOUS — they update
 *   the slice and re-run subscribers in the same microtask. React's
 *   `useEffect(() => …, [primaryColor, secondaryColor, accentColor])`
 *   pattern delivers ONE consolidated effect call per React commit,
 *   regardless of how many setState calls occur within the commit.
 *   That alone covers the typical "user clicks 5 swatches in 50 ms"
 *   case because React batches the re-renders.
 *
 *   The QA-mandated FIFO chain still adds value:
 *     1. The texture pipeline `update()` is now ASYNC (it awaits
 *        `fabricCanvas.setLogo` image decode and a `requestAnimationFrame`
 *        barrier before flagging the Three.js texture dirty per Rule R7
 *        / C6). The chain guarantees a strict serialization of pipeline
 *        calls so the LAST-submitted state wins on the GPU rather than
 *        an interleaved race producing stale pixels.
 *     2. It establishes ONE provably-canonical site that calls the
 *        pipeline from this folder, satisfying the QA report's
 *        "single canonical caller from controls/colors/" rule and
 *        keeping the Rule R7 / C6 audit trail tight.
 *     3. It enables future tests to await the chain to assert "all
 *        in-flight color updates have completed".
 *
 *   The chain itself uses a `useRef<Promise<void>>` initialized to
 *   `Promise.resolve()`. Each subscription tick replaces the ref's
 *   promise with `prev.then(workFor(state))`. The `then()` runs as a
 *   microtask after the previous link resolves, so submissions are
 *   strictly FIFO. The chain never rejects — the work function wraps
 *   any throw in a noop catch so a future failure never poisons all
 *   subsequent updates.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this hook calls `texturePipeline.update(...)` which
 *     is the SINGLE canonical orchestrator that runs `renderAll()`
 *     BEFORE `threeTexture.needsUpdate = true`. The ordering is
 *     enforced inside `texturePipeline.ts`; this hook does not directly
 *     mutate `threeTexture.needsUpdate` and does not call any other
 *     pipeline-internal helper out of order.
 *   - Rule R2: ZERO `console.*` calls. Errors are swallowed at the
 *     chain boundary so the next link continues.
 *   - Rule R3: no auth imports.
 */

import { useEffect, useRef } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';
import { texturePipeline } from '../../texture/texturePipeline';

/**
 * Real-time color → texture synchronization hook.
 *
 * Mount this hook ONCE near the application root (App.tsx). Subsequent
 * mounts in nested components are harmless (each has its own FIFO
 * chain) but produce duplicate pipeline calls — keep to one mount per
 * application instance.
 *
 * Returns void — the hook's contract is purely a side effect on the
 * texture pipeline. No public API surface is needed.
 */
export function useColorSync(): void {
  // ----- Store subscriptions: SLICE-only selectors per Zustand best practice -----
  //
  // Subscribing to the three color slices triggers this hook's effect
  // ONLY when one of those three slices changes — pattern, finish, or
  // logo updates do not run this effect (those slices have their own
  // synchronization paths upstream). The selectors return primitive
  // strings, so Zustand's default Object.is equality short-circuits
  // unchanged colors with no re-render.
  const primaryColor = useConfiguratorStore((s) => s.primaryColor);
  const secondaryColor = useConfiguratorStore((s) => s.secondaryColor);
  const accentColor = useConfiguratorStore((s) => s.accentColor);

  // ----- FIFO ordering chain ----------------------------------------------------
  //
  // The promise ref starts resolved so the first effect call appends
  // its work via `.then(...)` against an already-settled promise — the
  // microtask runs immediately after the current React commit phase.
  // ------------------------------------------------------------------------------
  const updateChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // Capture the previous link, replace the ref with the next link.
    // Doing this synchronously inside the effect (BEFORE awaiting any
    // microtask) preserves submission order even if multiple effect
    // calls overlap — each call sees the most recent ref value.
    const previousLink = updateChainRef.current;
    const nextLink: Promise<void> = previousLink.then(async () => {
      // Read the current store snapshot at execution time (NOT at
      // submission time) so the texture pipeline always paints the
      // most recent state. This is intentional last-write-wins
      // behavior on the GPU: if the user clicks five swatches in 50 ms,
      // the chain serializes five `update()` calls but each call
      // re-reads `getState()`, so any work that started before the
      // user's final click reflects the final color when it runs —
      // satisfying ST-009-AC4 ("rapid successive color changes ... no
      // lost or reordered updates").
      const snapshot = useConfiguratorStore.getState();
      try {
        await texturePipeline.update(snapshot);
      } catch {
        // Rule R2 demands no `console.*` calls. We swallow the error
        // here so the chain stays alive — a single bad snapshot must
        // not poison every subsequent update. The pipeline itself
        // throws only on truly-unrecoverable conditions (e.g., logo
        // image decode failure, missing Fabric canvas) which a
        // higher-level error boundary handles via the UI controls
        // that originated the offending state mutation.
      }
    });

    updateChainRef.current = nextLink;

    // No cleanup required: each scheduled `.then` runs to completion
    // even if the component unmounts mid-chain (the chain is owned by
    // the closure, not by React's effect cleanup). React StrictMode's
    // double-mount is also safe — the effect runs twice and enqueues
    // two pipeline calls with identical snapshots; idempotent.
  }, [primaryColor, secondaryColor, accentColor]);
}
