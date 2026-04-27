/**
 * signed-url.integration.test.ts
 *
 * RULE R5 / C1 VERIFICATION — every getSignedUrl call site in backend/src
 * MUST pass version: 'v4' in its options object.
 *
 * Authority: AAP §0.2.2 C1, §0.8.1 Rule R5.
 *   - C1 (verbatim): "Every call site in `backend/src/**\/*.ts` that
 *     invokes `bucket.file(name).getSignedUrl` MUST pass an options
 *     object containing `version: 'v4', action: 'read', expires:
 *     Date.now() + 15 * 60 * 1000`. The v7 SDK removed `getSignedUrl`
 *     from `File` instances without explicit `version`; omitting the
 *     `version` key throws at runtime. Verification: `grep -rn
 *     'getSignedUrl' backend/src` must show `version: 'v4'` alongside
 *     every occurrence."
 *   - R5 (verbatim): "Every call MUST use `bucket.file(name).getSignedUrl({
 *     version: 'v4', ... })`. MUST NOT call `.getSignedUrl()` without
 *     explicit `version`."
 *
 * Source stories:
 *   - tickets/stories/ST-044-integration-test-suite.md (integration
 *     test suite — deterministic fixtures, fail-closed reporting,
 *     LocalGCP-only operation).
 *   - tickets/stories/ST-014-logo-upload-ui.md (logo upload UI — the
 *     signed-URL contract underpins logo retrieval after upload, so
 *     the contract guarded here is what the upload UI consumes).
 *
 * Module under test: backend/src/services/gcs.service.ts
 *   (createGcsService, READ_URL_TTL_MS, UPLOAD_URL_TTL_MS).
 *
 * Verification surfaces:
 *   1. Runtime: createTestObject → createGcsService().getReadUrl /
 *      getUploadUrl — assert v4-specific X-Goog-* query parameters are
 *      present and the X-Goog-Expires=900 (15 minutes) query parameter
 *      is exactly that integer.
 *   2. Static: grep over backend/src/**\/*.ts (excluding *.test.ts) to
 *      assert `version: 'v4'` appears within 11 lines of every
 *      getSignedUrl occurrence — catches the one failure mode Rule R5
 *      is designed to prevent.
 *   3. Expiration math: returned `expiresAt` is approximately
 *      READ_URL_TTL_MS / UPLOAD_URL_TTL_MS in the future (within the
 *      configured TIMING_SLACK_MS tolerance).
 *
 * LocalGCP target: fake-gcs-server addressed by GCS_EMULATOR_HOST.
 * ZERO live GCP credentials are used or required (LocalGCP
 * Verification Rule, AAP §0.8.2). Test objects are created in
 * `beforeEach` via the gcs-bucket fixture and removed in `afterEach`,
 * satisfying the rule's mandate that integration tests create and
 * clean up their own resources.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createGcsService,
  READ_URL_TTL_MS,
  UPLOAD_URL_TTL_MS,
} from '../../../src/services/gcs.service';
import { createTestObject, deleteTestObject } from '../fixtures/gcs-bucket';

// ---------------------------------------------------------------------------
// Module-Level Constants
// ---------------------------------------------------------------------------

/**
 * The canonical X-Goog-Expires integer for a 15-minute TTL.
 *
 * `Date.now() + 15 * 60 * 1000` (per C1) yields a `Date` 15 minutes in
 * the future; the v7 SDK encodes the delta from "now" as the integer
 * number of seconds in the `X-Goog-Expires` query parameter — exactly
 * 900. Used by the X-Goog-Expires anchored regex in tests 5.5 and 6.1.
 */
const FIFTEEN_MINUTES_IN_SECONDS = 900; // 15 * 60

/**
 * Tolerance window for the Date.now() + TTL → expiresAt math.
 *
 * The test captures `Date.now()` immediately before the SDK call, then
 * compares the returned `expiresAt - before` delta against the
 * documented TTL constant. Real-world test execution introduces some
 * latency (ts-jest worker ramp-up, network round trip to fake-gcs-server,
 * any incidental GC pause). 5 seconds is an order of magnitude larger
 * than any of these in practice and tight enough to surface a real
 * regression (e.g. accidentally setting TTL to 1 hour would diverge by
 * 45 minutes — well outside this slack).
 */
const TIMING_SLACK_MS = 5_000;

/**
 * Tolerance window for the X-Goog-Date freshness check.
 *
 * The X-Goog-Date query parameter is the wall-clock at which the SDK
 * generated the signed URL. It MUST be close to "now" — both because
 * GCS rejects URLs that are too far in the past or future, and because
 * a wildly mismatched X-Goog-Date is a strong signal of clock drift on
 * the host. 60 seconds covers normal NTP jitter while still catching
 * real misconfiguration (e.g., a container with a clock 5 minutes off).
 */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('GCS v4 signed URL contract (Rule R5 / C1)', () => {
  // -------------------------------------------------------------------------
  // Phase 5 — Runtime Contract: getReadUrl
  // -------------------------------------------------------------------------
  describe('runtime: getReadUrl produces v4-signed URLs', () => {
    let objectKey: string;

    beforeEach(async () => {
      // Per-test UUID suffix prevents cross-test contamination when the
      // bucket is shared across describe blocks within a single run, and
      // satisfies the LocalGCP Verification Rule's "tests create their
      // own resources" mandate.
      objectKey = `test-${randomUUID()}-read.png`;
      // Seed a small PNG fixture at this key in the per-run test bucket
      // (fake-gcs-server). The contents are an ASCII placeholder rather
      // than real PNG bytes — the URL syntax tests below do NOT fetch
      // the object; they only assert on the URL the SDK produces.
      await createTestObject(objectKey, Buffer.from('fake-png-bytes'), 'image/png');
    });

    afterEach(async () => {
      // Idempotent cleanup. `deleteTestObject` tolerates 404 internally,
      // so a test that already deleted the object (or that raced against
      // the bucket-level teardown safety net) does not surface as a
      // failure here.
      await deleteTestObject(objectKey);
    });

    // ----- Test 5.1 ------------------------------------------------------
    it('exposes the v4 signing algorithm marker (X-Goog-Algorithm=GOOG4-RSA-SHA256)', async () => {
      // The v4 signing protocol identifies itself in URLs via the
      // `X-Goog-Algorithm=GOOG4-RSA-SHA256` query parameter. v2 URLs
      // omit this parameter entirely; v4 URLs MUST include it.
      const result = await createGcsService().getReadUrl(objectKey);
      expect(result.url).toMatch(/X-Goog-Algorithm=GOOG4-RSA-SHA256/);
    });

    // ----- Test 5.2 ------------------------------------------------------
    it('exposes the X-Goog-SignedHeaders v4 query parameter', async () => {
      // X-Goog-SignedHeaders is a v4-only field listing the headers
      // included in the canonical request signature. Its presence
      // distinguishes v4 from v2 (which has no equivalent field).
      const result = await createGcsService().getReadUrl(objectKey);
      expect(result.url).toMatch(/X-Goog-SignedHeaders=/);
    });

    // ----- Test 5.3 ------------------------------------------------------
    it('exposes the X-Goog-Credential v4 query parameter', async () => {
      // X-Goog-Credential carries the credential scope in the v4
      // protocol. Its v2 analogue is `GoogleAccessId=` (a bare
      // service-account email). Test 5.8 below explicitly asserts the
      // v2 form is NOT present.
      const result = await createGcsService().getReadUrl(objectKey);
      expect(result.url).toMatch(/X-Goog-Credential=/);
    });

    // ----- Test 5.4 ------------------------------------------------------
    it('exposes a recent X-Goog-Date timestamp in basic ISO-8601 format', async () => {
      // The v4 protocol encodes the URL-generation wall-clock as a
      // basic ISO-8601 timestamp (no separators) in X-Goog-Date.
      // Format: `YYYYMMDDThhmmssZ` (15 characters). We capture
      // `Date.now()` BEFORE the SDK call so the comparison is robust
      // against any latency the SDK's internal asynchronous signing
      // operation introduces.
      const before = Date.now();
      const result = await createGcsService().getReadUrl(objectKey);

      // Match the basic ISO-8601 form. `[?&]` ensures we anchor to a
      // query parameter boundary (start-of-query or after `&`), not
      // accidentally match a substring of another parameter's value.
      const match = result.url.match(/[?&]X-Goog-Date=(\d{8}T\d{6}Z)/);
      expect(match).not.toBeNull();

      // `match!` is justified: the immediately preceding `expect(match)
      // .not.toBeNull()` would have failed the test if `match` were
      // null. ESLint allows non-null assertions in test files (see
      // .eslintrc.json overrides); this single use is the minimum
      // necessary to convince the type checker.
      const dateStr = match![1];

      // Convert basic ISO-8601 (YYYYMMDDThhmmssZ) → extended ISO-8601
      // (YYYY-MM-DDThh:mm:ssZ) so `new Date()` parses it portably.
      // The basic form is technically valid ISO-8601 but Node's `Date`
      // parser is more reliable on the extended form across versions.
      const isoExtended =
        `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T` +
        `${dateStr.slice(9, 11)}:${dateStr.slice(11, 13)}:${dateStr.slice(13, 15)}Z`;
      const parsed = new Date(isoExtended);
      // Guard: an invalid date returns NaN from `getTime()`, which
      // `Number.isFinite` rejects. This catches malformed timestamps
      // that the regex's relaxed `\d{8}T\d{6}Z` form would accept.
      expect(Number.isFinite(parsed.getTime())).toBe(true);

      // The X-Goog-Date should be within the clock-skew tolerance of
      // the wall-clock captured immediately before the SDK call. A
      // larger skew indicates a real environment defect (host clock
      // drift, container time misconfigured) which Rule R8 demands we
      // surface as a fail-closed verdict.
      const skew = Math.abs(before - parsed.getTime());
      expect(skew).toBeLessThan(CLOCK_SKEW_TOLERANCE_MS);
    });

    // ----- Test 5.5 ------------------------------------------------------
    it('encodes a 15-minute (900 second) expiration as X-Goog-Expires=900', async () => {
      // X-Goog-Expires is the integer number of seconds the URL is
      // valid. C1 mandates `Date.now() + 15 * 60 * 1000` which yields
      // exactly 900 seconds. The regex anchors precisely:
      //   - `[?&]` ensures parameter-boundary alignment.
      //   - `(?:[&]|$)` ensures `9000` cannot match `=900`. Without
      //     the trailing alternation, a future TTL change to 9000
      //     seconds would silently pass this test.
      const result = await createGcsService().getReadUrl(objectKey);
      expect(result.url).toMatch(
        new RegExp(`[?&]X-Goog-Expires=${FIFTEEN_MINUTES_IN_SECONDS}(?:[&]|$)`),
      );
    });

    // ----- Test 5.6 ------------------------------------------------------
    it('exposes the X-Goog-Signature query parameter', async () => {
      // X-Goog-Signature is the hex-encoded HMAC-SHA256 signature of
      // the v4 canonical request. Its presence (alongside the
      // GOOG4-RSA-SHA256 algorithm marker) is the strongest single
      // indicator that the URL is v4-signed rather than v2-signed.
      const result = await createGcsService().getReadUrl(objectKey);
      expect(result.url).toMatch(/X-Goog-Signature=/);
    });

    // ----- Test 5.7 ------------------------------------------------------
    it('does NOT contain v2 signature marker (Goog-Signature-Version=GOOG1)', async () => {
      // Defense in depth: explicitly assert the v2 protocol marker is
      // absent. A future SDK upgrade that silently regressed to v2
      // (or an accidental `version: 'v2'` typo on a future
      // getSignedUrl call) would leave the v4 markers absent AND
      // introduce this v2 marker — this assertion catches that
      // failure mode independently of the positive v4 assertions.
      const result = await createGcsService().getReadUrl(objectKey);
      expect(result.url).not.toMatch(/Goog-Signature-Version=GOOG1/);
    });

    // ----- Test 5.8 ------------------------------------------------------
    it('does NOT contain v2 marker (bare GoogleAccessId query parameter)', async () => {
      // `GoogleAccessId=` as a bare query parameter is a v2 hallmark:
      // v2 URLs encode the service-account email here directly. v4
      // URLs use `X-Goog-Credential=` (asserted in test 5.3) instead.
      // The `[?&]` anchor ensures we don't accidentally match a
      // substring of another parameter (e.g., a fictional
      // `XGoogleAccessIdField=` would not match).
      const result = await createGcsService().getReadUrl(objectKey);
      expect(result.url).not.toMatch(/[?&]GoogleAccessId=/);
    });

    // ----- Test 5.9 ------------------------------------------------------
    it('returns expiresAt approximately 15 minutes in the future', async () => {
      // Capture wall-clock immediately before the SDK call. The
      // returned `expiresAt` Date should equal `before + READ_URL_TTL_MS`
      // within the TIMING_SLACK_MS tolerance window (which absorbs
      // ts-jest startup variance and any incidental I/O latency).
      const before = Date.now();
      const result = await createGcsService().getReadUrl(objectKey);

      const elapsed = result.expiresAt.getTime() - before;
      // Symmetric tolerance: the elapsed delta MUST be within
      // ±TIMING_SLACK_MS of the documented TTL. A regression that
      // changed READ_URL_TTL_MS from 900,000 to (e.g.) 60,000 would
      // produce elapsed ≈ 60,000 — well below the lower bound of
      // 895,000 — and fail loudly here.
      expect(elapsed).toBeGreaterThanOrEqual(READ_URL_TTL_MS - TIMING_SLACK_MS);
      expect(elapsed).toBeLessThanOrEqual(READ_URL_TTL_MS + TIMING_SLACK_MS);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 6 — Runtime Contract: getUploadUrl (write action)
  // -------------------------------------------------------------------------
  describe('runtime: getUploadUrl produces v4-signed URLs (write action)', () => {
    // No object pre-creation needed for upload URL minting. The URL is
    // mintable for any key whether or not the object exists yet — and
    // for upload URLs (write action) the object DOESN'T exist by
    // definition: the URL is what the client uses to PUT the bytes.
    // This intentional shape difference from the getReadUrl describe
    // block is documented here so future maintainers don't add
    // `createTestObject` calls thinking they were forgotten.

    it('exposes the same v4 markers as getReadUrl', async () => {
      // Use a fresh UUID-suffixed key per test (LocalGCP rule:
      // self-contained resources). The upload URL is identical in v4
      // protocol shape to the read URL except for the `action: 'write'`
      // option that gcs.service.ts passes — the wire-level URL
      // markers are the same.
      const uploadKey = `test-${randomUUID()}-upload.png`;
      const result = await createGcsService().getUploadUrl(uploadKey);

      // Positive v4 markers (mirror Tests 5.1 – 5.6).
      expect(result.url).toMatch(/X-Goog-Algorithm=GOOG4-RSA-SHA256/);
      expect(result.url).toMatch(/X-Goog-SignedHeaders=/);
      expect(result.url).toMatch(/X-Goog-Credential=/);
      expect(result.url).toMatch(/[?&]X-Goog-Date=\d{8}T\d{6}Z/);
      expect(result.url).toMatch(
        new RegExp(`[?&]X-Goog-Expires=${FIFTEEN_MINUTES_IN_SECONDS}(?:[&]|$)`),
      );
      expect(result.url).toMatch(/X-Goog-Signature=/);

      // Negative v2 markers (mirror Tests 5.7 – 5.8). The "no v2"
      // assertions are tested for both URL types because a regression
      // that affected only one of getReadUrl/getUploadUrl (e.g., a
      // refactor that consolidated the two call sites and accidentally
      // dropped `version: 'v4'` from one branch) would otherwise slip
      // through.
      expect(result.url).not.toMatch(/Goog-Signature-Version=GOOG1/);
      expect(result.url).not.toMatch(/[?&]GoogleAccessId=/);
    });

    it('returns expiresAt approximately 15 minutes in the future for uploads', async () => {
      // Same elapsed-time math as Test 5.9, but against
      // UPLOAD_URL_TTL_MS. In the current implementation
      // (gcs.service.ts) UPLOAD_URL_TTL_MS === READ_URL_TTL_MS, but the
      // assertion is parameterized so a future intentional divergence
      // (e.g., shorter upload TTLs to reduce the credential-leak
      // window) would not require a test rewrite.
      const uploadKey = `test-${randomUUID()}-upload-ttl.png`;
      const before = Date.now();
      const result = await createGcsService().getUploadUrl(uploadKey);

      const elapsed = result.expiresAt.getTime() - before;
      expect(elapsed).toBeGreaterThanOrEqual(UPLOAD_URL_TTL_MS - TIMING_SLACK_MS);
      expect(elapsed).toBeLessThanOrEqual(UPLOAD_URL_TTL_MS + TIMING_SLACK_MS);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 7 — Static Analysis: every getSignedUrl call site uses version: 'v4'
  // -------------------------------------------------------------------------
  describe('static analysis: every getSignedUrl call site in backend/src uses version: "v4"', () => {
    it('grep over backend/src finds version: "v4" within 11 lines of every getSignedUrl match', () => {
      // Resolve `backend/src` relative to THIS test file. The test
      // works regardless of the directory Jest is invoked from
      // (monorepo root vs. `cd backend && npx jest`) because
      // `__dirname` is fixed at the file's compile location.
      const srcDir = path.resolve(__dirname, '../../../src');

      let output = '';
      try {
        // `--include="*.ts"` restricts to TypeScript source files.
        // `--exclude="*.test.ts"` skips co-located unit-test files
        // under backend/src/services/*.test.ts where mock setups
        // legitimately mention `getSignedUrl` without a real call site.
        output = execSync(
          `grep -rn --include="*.ts" --exclude="*.test.ts" "getSignedUrl" ${srcDir}`,
          { encoding: 'utf-8', maxBuffer: 1024 * 1024 },
        );
      } catch (err) {
        // grep exits with status 1 when there are no matches — distinct
        // from a real error (status 2) like an inaccessible file. We
        // distinguish here per Rule R8 (fail-closed): a "no matches"
        // verdict is itself a failure because gcs.service.ts MUST
        // contain at least one v4 call site (this is its sole
        // architectural responsibility).
        const status = (err as NodeJS.ErrnoException & { status?: number }).status;
        if (status === 1) {
          throw new Error(
            'No getSignedUrl call sites found in backend/src — gcs.service.ts ' +
              'must contain at least one v4 call site. The Rule R5 / C1 ' +
              'verification surface depends on the production code ' +
              'invoking bucket.file(name).getSignedUrl({ version: "v4", ... }).',
          );
        }
        throw err;
      }

      // grep emits one line per match. Empty trailing lines are
      // discarded so the loop iterates over real matches only.
      const lines = output.split('\n').filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThan(0);

      // Track real call sites (non-comment lines) separately so we can
      // assert at least one exists. Per Rule R5/C1, a "call site" is an
      // actual code line that invokes `bucket.file(name).getSignedUrl`.
      // JSDoc `* ...` lines and `// ...` line-comments cannot be call
      // sites because they do not execute, so they are outside the
      // scope of this verification (per AAP §0.6.7 Phase 15 documented
      // design choice that accepts comment-style false positives).
      let realCallSiteCount = 0;

      for (const rawLine of lines) {
        // grep -n format: `<filePath>:<lineNum>:<content>`. We split on
        // the FIRST two colons (not all colons) because file paths can
        // contain colons in pathological setups, and the `<content>`
        // portion almost always contains colons (TypeScript object
        // literals, type annotations, ternary expressions).
        const colonIdx = rawLine.indexOf(':');
        const colonIdx2 = rawLine.indexOf(':', colonIdx + 1);
        expect(colonIdx).toBeGreaterThan(-1);
        expect(colonIdx2).toBeGreaterThan(colonIdx);

        const filePath = rawLine.slice(0, colonIdx);
        const lineNumStr = rawLine.slice(colonIdx + 1, colonIdx2);
        const matchedContent = rawLine.slice(colonIdx2 + 1);
        const lineNum = Number.parseInt(lineNumStr, 10);
        expect(Number.isInteger(lineNum)).toBe(true);
        expect(lineNum).toBeGreaterThan(0);

        // Skip comment-only matches. A line is a comment if its first
        // non-whitespace character is `*` (JSDoc / block-comment
        // continuation) or it begins with `//` after whitespace.
        // gcs.service.ts contains a substantial JSDoc header that
        // legitimately references `getSignedUrl` for documentation
        // purposes; those references are not call sites and cannot
        // violate Rule R5. The runtime tests above (Phase 5/6) already
        // verify the v4 contract end-to-end against the real code path.
        const trimmedContent = matchedContent.trimStart();
        const isCommentLine =
          trimmedContent.startsWith('*') || trimmedContent.startsWith('//');
        if (isCommentLine) {
          continue;
        }

        realCallSiteCount += 1;

        // Read an 11-line window starting at the matched line.
        // Eleven lines is enough to cover:
        //   - Same-line: bucket.file(k).getSignedUrl({ version: 'v4', action: 'read' });
        //   - Multi-line option object (typical formatter output):
        //       const [url] = await bucket.file(objectKey).getSignedUrl({
        //         version: 'v4',                       <- next line
        //         action: 'read',
        //         expires: expiresMs,
        //       });
        //   - Realistic upper bound: signed-URL helper functions that
        //     wrap the call across ~10 lines.
        const window = execSync(
          `sed -n '${lineNum},${lineNum + 10}p' '${filePath}'`,
          { encoding: 'utf-8', maxBuffer: 64 * 1024 },
        );

        // The window MUST contain `version: 'v4'` (single OR double
        // quotes). If a future developer adds a getSignedUrl call
        // without the `version` key — or wraps the options in a
        // spread that hides `version` from this static check — the
        // assertion fails loudly with the offending line number in
        // the failure message.
        expect(window).toMatch(/version:\s*['"]v4['"]/);
      }

      // At least ONE real call site MUST exist in backend/src.
      // gcs.service.ts is the SOLE architectural home of the
      // getSignedUrl invocation surface (per AAP §0.6.4); if no
      // call site is found, Rule R5 has nothing to enforce — which
      // is itself a failure under R8 (fail-closed).
      expect(realCallSiteCount).toBeGreaterThan(0);
    });
  });
});
