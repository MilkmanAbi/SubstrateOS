/**
 * BORK Memory Profiles
 *
 * These are practical presets, not magic numbers. They exist so a dev who
 * doesn't want to think about limits can say mm.profile("mobile") and get
 * sane behaviour for that class of device without hand-tuning.
 *
 * If you call mm.setLimit() directly, you're saying "I know exactly what
 * I'm doing." Profiles will not override you. Nothing will, unless you're
 * NOT running with --platform-guaranteed-stability, in which case adaptive
 * fallback still runs — it'll just quietly tighten things if the tab starts
 * dying. That's the deal.
 *
 * Profile semantics:
 *
 *   mobile      — phone-class device, 2-3GB tab limit, be conservative
 *                 aggressive eviction, low velocity tolerance, tight per-proc limits
 *
 *   desktop     — modern desktop, 4-8GB tab headroom, balanced everything
 *                 moderate eviction, moderate velocity, standard limits
 *
 *   aggressive  — dev-tested setup, confident about their workload, still
 *                 using a profile instead of manual because they want SOME
 *                 guardrails. High limits, slow eviction, relaxed velocity.
 *                 "I benchmarked this, it's fine, but save me from typos."
 */

export const PROFILES = {

  mobile: {
    poolMB:           128,
    maxPoolMB:        512,
    defaultSoftMB:    16,
    defaultHardMB:    48,
    swapEnabled:      true,
    swapDrivers:      ['localStorage', 'sessionStorage'],
    eviction: {
      aggressiveness:  0.9,    // 0-1, higher = evict sooner
      pressureThresh:  0.55,   // start evicting at 55% pool usage
      killThresh:      0.82,   // kill processes at 82% pool usage
      checkIntervalMs: 800,
    },
    velocity: {
      windowMs:         2000,
      maxMBperSec:      8,     // scream at 8MB/s sustained
      burstTolerance:   1.2,   // allow 1.2x normal for short bursts
      throttleOnBreach: true,
    },
    adaptiveFallback:  true,   // override-able only by --platform-guaranteed-stability
    description:       'Conservative profile for phone-class devices.',
  },

  desktop: {
    poolMB:           256,
    maxPoolMB:        2048,
    defaultSoftMB:    32,
    defaultHardMB:    128,
    swapEnabled:      true,
    swapDrivers:      ['localStorage', 'sessionStorage'],
    eviction: {
      aggressiveness:  0.55,
      pressureThresh:  0.68,
      killThresh:      0.90,
      checkIntervalMs: 1500,
    },
    velocity: {
      windowMs:         3000,
      maxMBperSec:      24,
      burstTolerance:   1.8,
      throttleOnBreach: false,  // warn but don't throttle on desktop
    },
    adaptiveFallback:  true,
    description:       'Balanced profile for modern desktop browsers.',
  },

  aggressive: {
    poolMB:           512,
    maxPoolMB:        3072,    // above 2048 needs --platform-guaranteed-stability
    defaultSoftMB:    96,
    defaultHardMB:    384,
    swapEnabled:      false,   // dev is confident they won't need swap
    swapDrivers:      [],
    eviction: {
      aggressiveness:  0.3,
      pressureThresh:  0.82,
      killThresh:      0.96,
      checkIntervalMs: 3000,
    },
    velocity: {
      windowMs:         6000,
      maxMBperSec:      80,
      burstTolerance:   3.0,
      throttleOnBreach: false,
    },
    adaptiveFallback:  true,   // still adaptive — dev used a profile, not --pgs
    description:       'High-headroom profile for dev-tested workloads. Baby guardrails only.',
  },

};

/**
 * --platform-guaranteed-stability profile
 *
 * Not really a profile — it's a declaration.
 * You are telling BORK:
 *   - I have tested this on the actual platform this will run on
 *   - I understand what 3GB of ArrayBuffer in a tab costs
 *   - I do not want BORK to second-guess me, tighten limits, trigger
 *     eviction early, or do anything "helpful" behind my back
 *
 * What this disables:
 *   - Adaptive fallback (limit auto-tightening under pressure)
 *   - MemoryVelocity throttling
 *   - Automatic eviction decisions by DMU
 *   - Any safety caps above 2048MB
 *
 * What this enables:
 *   - Full allocation freedom up to whatever the platform allows
 *   - setLimit() without any ceiling enforced by BORK
 *   - DMU still runs but ONLY logs — it does not act
 *
 * Translation: "BORK will not save you anymore."
 * If the tab dies, it dies. You said it wouldn't.
 */
export const PLATFORM_GUARANTEED_STABILITY = {
  poolMB:           512,
  maxPoolMB:        Infinity,  // BORK imposes no ceiling — browser wins
  defaultSoftMB:    Infinity,  // no per-process warnings
  defaultHardMB:    Infinity,  // no per-process kills
  swapEnabled:      false,
  swapDrivers:      [],
  eviction: {
    aggressiveness:  0,
    pressureThresh:  1.0,      // effectively never triggers
    killThresh:      1.0,
    checkIntervalMs: 60000,    // check once a minute — logging only
  },
  velocity: {
    windowMs:         Infinity,
    maxMBperSec:      Infinity,
    burstTolerance:   Infinity,
    throttleOnBreach: false,
  },
  adaptiveFallback:  false,    // explicitly disabled — that's the whole point
  _pgs:              true,     // flag: platform-guaranteed-stability is active
  description:       'PGS: BORK will not save you anymore. Full allocation freedom.',
};
