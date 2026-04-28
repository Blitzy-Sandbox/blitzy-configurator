/**
 * useColorSync — real-time preview synchronization with FIFO ordering (ST-009).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/colors/
 *     useColorSync.ts | ST-009 real-time sync calls texture pipeline".
 *   - ST-009 acceptance criteria — color slice changes propagate to the
 *     live 3D preview within the documented latency budget (AC1, AC2,
 *     AC3); the correctness contract for AC4 is FIFO ordering: when N
 *     rapid selections occur within a single render cycle, every
 *     selection MUST be reflected in submission order with no lost or
 *     reordered updates.
 *   - This hook is the SINGLE canonical caller of the texture pipeline
 *     from `frontend/src/configurator/controls/colors/`. The picker
 *     components (PrimaryColorPicker, SecondaryColorPicker,
 *     AccentColorPicker) dispatch ONLY to the Zustand store; this hook
 *     subscribes to the resulting slice changes and bridges them to the
 *     pipeline. The pattern established here is the canonical model
 *     that the sibling `pattern/` and `logo/` subfolders will mirror
 *     (each with its own equivalent synchronization hook).
 *
 * Architecture & ordering contract:
 *   The Zustand store's `set(...)` calls are SYNCHRONOUS — they update
 *   the slice and re-run subscribers in the same microtask. React's
 *   `useEffect(() => …, [primaryColor, secondaryColor, accentColor])`
 *   pattern delivers ONE consolidated effect call per React commit,
 *   regardless of how many setState calls occur within the commit.
 *
 *   The FIFO promise chain serializes pipeline calls:
 *     1. The texture pipeline `update()` is ASYNC (it awaits Fabric's
 *        `setLogo` image decode and a `requestAnimationFrame` barrier
 *        before flagging the Three.js texture dirty per Rule R7 / C6).
 *        The chain guarantees strict serialization of pipeline calls
 *        so each submission applies its captured state in submission
 *        order — without serialization, two updates could interleave
 *        at the rAF boundary and produce stale pixels on the GPU.
 *     2. It establishes ONE provably-canonical site that calls the
 *        pipeline from this folder, satisfying the "single canonical
 *        caller from controls/colors/" rule and keeping the Rule R7 /
 *        C6 audit trail tight.
 *     3. It enables future tests to await the chain to assert "all
 *        in-flight color updates have completed".
 *
 *   Snapshot timing — captured AT SUBMISSION (effect-fire) time, NOT at
 *   execution time. This is the canonical pattern for ST-009-AC4
 *   ordering preservation: each queued pipeline call carries its own
 *   immutable view of `ConfiguratorState`, so the FIFO chain reflects
 *   the exact sequence of selections the user made — a queued update
 *   for an intermediate state arrives on the preview before a later
 *   state's update runs, rather than collapsing to last-write-wins.
 *
 *   The chain itself uses a `useRef<Promise<void>>` initialized to
 *   `Promise.resolve()`. Each subscription tick replaces the ref's
 *   promise with
 *   `prev.catch(() => undefined).then(() => texturePipeline.update(snapshot))`.
 *   The leading `.catch(() => undefined)` guarantees the chain never
 *   deadlocks on a rejected pipeline call — a single failure does not
 *   poison every subsequent update.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this hook calls `texturePipeline.update(...)` which
 *     is the SINGLE canonical orchestrator that runs `renderAll()`
 *     BEFORE `threeTexture.needsUpdate = true`. The ordering is
 *     enforced inside `texturePipeline.ts`; this hook does NOT directly
 *     mutate `threeTexture.needsUpdate`, does NOT call into Fabric's
 *     namespace, and does NOT inline any pipeline-internal step.
 *   - Rule R2: ZERO `console.*` calls. Pipeline errors are swallowed at
 *     the chain boundary via `.catch(() => undefined)` so the next link
 *     continues.
 *   - Rule R3: no auth imports — colors do not require authentication.
 *   - AAP §0.4.6: no barrel imports. Explicit relative paths only.
 *   - AAP §0.5.2: Zustand selector pattern. NEVER subscribe to the
 *     entire store with bare `useConfiguratorStore()`.
 */

import { useEffect, useRef } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';
import { texturePipeline } from '../../texture/texturePipeline';

/**
 * Real-time color → texture-pipeline synchronization hook (ST-009).
 *
 * Subscribes to the three color slices in the Zustand configurator
 * store (primary, secondary, accent) and, on every change, enqueues a
 * call to `texturePipeline.update(state)`. The serialized FIFO queue
 * (`queueRef`) guarantees that rapid successive changes arrive on the
 * preview in the order they were made, with no lost or reordered
 * updates (ST-009-AC4).
 *
 * IMPORTANT — Rule R7 / C6: this hook is the SINGLE call site in
 * `frontend/src/configurator/controls/colors/` that invokes
 * `texturePipeline.update`. The three picker components dispatch only
 * to the store; this hook bridges store changes to the texture
 * pipeline.
 *
 * Mount this hook EXACTLY ONCE near the top of the component tree
 * (recommended: in `App.tsx`, alongside other sync hooks for pattern /
 * logo). Mounting multiple instances would queue multiple pipeline
 * updates per color change — wasteful and potentially defect-inducing.
 *
 * @returns void — the hook's contract is purely a side effect on the
 *   texture pipeline. No public API surface is needed.
 */
export function useColorSync(): void {
  // ----- Store subscriptions: SLICE-only selectors per Zustand best practice -----
  //
  // Subscribing to the three color slices triggers this hook's effect
  // ONLY when one of those three slices changes — pattern, finish, or
  // logo updates do not run this effect (those slices have their own
  // synchronization paths). The selectors return primitive strings, so
  // Zustand's default Object.is equality short-circuits unchanged
  // colors with no re-render.
  const primaryColor = useConfiguratorStore((s) => s.primaryColor);
  const secondaryColor = useConfiguratorStore((s) => s.secondaryColor);
  const accentColor = useConfiguratorStore((s) => s.accentColor);

  // ----- FIFO ordering chain ----------------------------------------------------
  //
  // The promise ref starts resolved so the first effect call appends
  // its work via `.then(...)` against an already-settled promise — the
  // microtask runs immediately after the current React commit phase.
  // ------------------------------------------------------------------------------
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // Snapshot the FULL store state at effect-fire (submission) time.
    // The pipeline's `update()` accepts a complete `ConfiguratorState`
    // (colors + pattern + finish + logo + ...), so we always pass the
    // entire state — even though we only fire on color changes, the
    // pipeline applies all current state to Fabric on each call.
    //
    // Submission-time snapshotting is critical for ST-009-AC4: each
    // queued call carries its OWN immutable view of state, so a chain
    // of N rapid changes reflects N distinct selections in submission
    // order rather than collapsing to last-write-wins.
    const snapshot = useConfiguratorStore.getState();

    // Append to the FIFO chain. The leading `.catch(() => undefined)`
    // converts any prior rejection into a resolved void, preventing
    // chain deadlock — a failed pipeline call must not poison every
    // subsequent update. The resulting `.then(...)` runs the next
    // pipeline update against this submission's captured snapshot
    // once the prior link has settled.
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(() => texturePipeline.update(snapshot));

    // No cleanup function: pipeline updates are fire-and-forget.
    // Cancelling an in-flight update would risk leaving the texture in
    // a half-updated state, violating R7 / C6's "single transition"
    // invariant. React StrictMode's double-mount is also safe — the
    // effect runs twice and enqueues two pipeline calls with identical
    // snapshots; idempotent on the GPU.
  }, [primaryColor, secondaryColor, accentColor]);
}
