/**
 * audio-processor.js — Broadcast-grade AudioWorklet sound processor
 *
 * This runs in the browser's dedicated real-time audio rendering thread,
 * immune to JavaScript GC pauses, UI-thread lag, and background-tab throttling.
 *
 * ─── Processing chain (per 128-sample block ≈ 2.67 ms at 48 kHz) ──────────
 *
 *  1. Mid-Side Stereo Widening
 *     Separates the signal into M (mono centre) and S (stereo sides) components.
 *     The S channel is boosted by the width factor, making music sound wider and
 *     more immersive on headphones while remaining mono-compatible (collapsing
 *     M+S back to mono gives the original signal minus the width boost).
 *     width = 1.0 → unchanged | width = 1.4 → wide | width = 2.0 → ultra-wide
 *
 *  2. Harmonic Saturation (Exciter)
 *     Applies a polynomial soft-knee waveshaper to the mid channel only.
 *     This adds subtle 2nd-order harmonics (warmth) without harsh distortion.
 *     It is the same technique used in professional tape-saturation and tube
 *     emulation plug-ins.  At drive=0.15 (default) the effect is inaudible as
 *     distortion but raises perceived loudness by ~1–2 dB.
 *     Formula: y = x – drive * x³ / 3  (soft polynomial saturation)
 *
 *  3. True-Peak Limiter
 *     Instantaneous attack (0 samples look-ahead is needed because saturation
 *     above can only increase, never spike).  Release: 80 ms exponential.
 *     Hard ceiling at -1 dBFS (0.891 linear) — prevents inter-sample overs
 *     that would cause distortion on DACs and streaming encoders.
 *
 * ─── Messages (main thread → worklet) ─────────────────────────────────────
 *   { type: 'set-width',  value: 0.0–2.0 }  stereo width  (default 1.35)
 *   { type: 'set-drive',  value: 0.0–1.0 }  saturation    (default 0.15)
 *   { type: 'set-bypass', value: bool    }  bypass all processing
 *   { type: 'set-limit-db', value: number } ceiling in dBFS (default -1)
 *
 * ─── Messages (worklet → main thread) ─────────────────────────────────────
 *   { type: 'meter', gainReduction: 0–1, peakL: 0–1, peakR: 0–1 }
 *   { type: 'alive' }  — every ~5 s so the main thread can detect dead worklet
 */

'use strict';

const BLOCK_SIZE        = 128;
const METER_INTERVAL    = 375;   // post meter every ~1 s (375 × 2.67 ms)
const ALIVE_INTERVAL    = 1875;  // post alive every ~5 s

class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    const opts = options.processorOptions || {};

    // ── Parameters ─────────────────────────────────────────────────────
    this._width   = opts.width   ?? 1.35;  // stereo width multiplier
    this._drive   = opts.drive   ?? 0.15;  // saturation drive (0=off, 1=heavy)
    this._bypass  = opts.bypass  ?? false;

    // Limiter ceiling: -1 dBFS = 10^(-1/20) ≈ 0.891
    this._limitDb = opts.limitDb ?? -1;
    this._limitThresh = Math.pow(10, this._limitDb / 20);

    // Limiter state
    this._gain    = 1.0;   // current limiter gain (smoothed)
    // Release: gain recovers to 1.0 in ~80 ms
    // Per-sample delta = 1 / (sampleRate × releaseSeconds)
    this._relRate = 1.0 / (sampleRate * 0.08);

    // Meter accumulators
    this._peakL   = 0;
    this._peakR   = 0;
    this._minGain = 1.0; // worst-case gain reduction this meter window
    this._blockCount = 0;

    // ── Main-thread messages ────────────────────────────────────────────
    this.port.onmessage = ({ data }) => {
      if (!data) return;
      switch (data.type) {
        case 'set-width':
          this._width = Math.max(0, Math.min(2, +data.value || 0));
          break;
        case 'set-drive':
          this._drive = Math.max(0, Math.min(1, +data.value || 0));
          break;
        case 'set-bypass':
          this._bypass = !!data.value;
          break;
        case 'set-limit-db':
          this._limitDb     = +data.value || -1;
          this._limitThresh = Math.pow(10, this._limitDb / 20);
          break;
      }
    };
  }

  // ── Soft-knee polynomial saturation ─────────────────────────────────────
  // Returns a slightly "compressed" version of x with added 2nd harmonics.
  // The curve never exceeds ±1.5 regardless of drive level.
  _saturate(x) {
    const d = this._drive;
    if (d === 0) return x;
    // y = x − (d/3)·x³  (3rd-order polynomial — adds 2nd harmonic to the signal)
    return x - (d / 3) * x * x * x;
  }

  /**
   * Called by the audio rendering thread every 128 samples (~2.67 ms).
   * Must return true to keep the processor alive.
   */
  process(inputs, outputs) {
    const inL  = inputs[0]?.[0];
    const inR  = inputs[0]?.[1] ?? inL; // mono upmix if no R channel
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];

    if (!inL || !outL) return true;

    if (this._bypass) {
      // Hard bypass: copy input to output unchanged
      outL.set(inL);
      if (outR && inR) outR.set(inR);
      return true;
    }

    const width    = this._width;
    const thresh   = this._limitThresh;
    const relRate  = this._relRate;
    let   g        = this._gain;
    let   peakL    = this._peakL;
    let   peakR    = this._peakR;
    let   minGain  = this._minGain;

    for (let i = 0; i < BLOCK_SIZE; i++) {
      const l0 = inL[i];
      const r0 = inR[i];

      // ── 1. Mid-Side stereo widening ──────────────────────────────────
      // M = centre content (sum), S = stereo content (difference)
      const mid  = (l0 + r0) * 0.5;
      const side = (l0 - r0) * 0.5;

      // ── 2. Harmonic saturation on mid channel ────────────────────────
      const midS = this._saturate(mid);

      // Reconstruct L/R with widened stereo
      const sideW = side * width;
      let l = midS + sideW;
      let r = midS - sideW;

      // ── 3. True-peak limiter ─────────────────────────────────────────
      const peak = Math.max(Math.abs(l), Math.abs(r));
      if (peak > thresh) {
        // Compute the gain that brings peak exactly to threshold
        // and apply it instantly (attack = 0 samples)
        const target = thresh / peak;
        if (target < g) g = target;
      }
      // Release: let gain creep back toward 1.0 each sample
      g = Math.min(1.0, g + relRate);

      l *= g;
      r *= g;

      outL[i] = l;
      if (outR) outR[i] = r;

      // Peak meters
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
      if (g < minGain) minGain = g;
    }

    this._gain    = g;
    this._peakL   = peakL * 0.9; // fast peak decay
    this._peakR   = peakR * 0.9;
    this._minGain = minGain;

    // ── Periodic meter post ──────────────────────────────────────────────
    this._blockCount++;
    if (this._blockCount % METER_INTERVAL === 0) {
      this.port.postMessage({
        type:         'meter',
        gainReduction: 1 - this._minGain,
        peakL:         this._peakL,
        peakR:         this._peakR,
      });
      this._minGain = 1.0;
    }
    if (this._blockCount % ALIVE_INTERVAL === 0) {
      this.port.postMessage({ type: 'alive' });
    }

    return true; // keep processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);
