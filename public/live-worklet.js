/**
 * live-worklet.js — AudioWorklet processor for gapless live radio playback
 *
 * ─── Why an AudioWorklet? ────────────────────────────────────────────────────
 * The AudioWorklet runs in the browser's dedicated audio rendering thread — a
 * real-time thread with elevated priority that is NOT subject to:
 *   • Main-thread JavaScript garbage collection pauses
 *   • Background-tab throttling (Chrome throttles setTimeout to 1 Hz in hidden tabs)
 *   • Long-task blocking from UI repaints or Socket.IO message handling
 *
 * This means audio monitoring and gap concealment happen with microsecond
 * accuracy regardless of what the main thread is doing.
 *
 * ─── What this processor does ───────────────────────────────────────────────
 * The audio element (fed by MediaSource/SourceBuffer) is connected to this
 * worklet via createMediaElementSource().  The worklet sits inline in the
 * audio graph:
 *
 *   SourceBuffer → <audio> element → MediaElementSourceNode
 *     → AudioWorkletNode(live-stream-processor) → AudioContext.destination
 *
 * On every 128-sample render block (~2.67 ms at 48 kHz) the processor:
 *   1. Copies input samples to output (pass-through)
 *   2. Measures RMS energy to detect silence/dropouts
 *   3. When a dropout starts, applies an exponential gain fade-out (10 ms)
 *      to eliminate the hard click that would otherwise occur
 *   4. When audio resumes after a dropout, applies an exponential fade-in
 *   5. Tracks buffer fill stats and periodically posts them to the main thread
 *      so the admin UI can show live quality metrics
 *
 * ─── Messages (main thread → worklet) ──────────────────────────────────────
 *   { type: 'reset' }              — clear all state (called on live:ended)
 *   { type: 'set-gain', value: n } — target output gain (0.0 – 1.0)
 *
 * ─── Messages (worklet → main thread) ──────────────────────────────────────
 *   { type: 'stats', rms, isDropout, fadeGain, sampleTime }
 *   { type: 'dropout-start' }
 *   { type: 'dropout-end',   durationMs: n }
 *   { type: 'alive' }            — sent every ~5 s so main thread can detect dead worklet
 */

'use strict';

// ─── Tuning constants ────────────────────────────────────────────────────────
const SAMPLE_RATE       = 48000;          // most browsers use 48 kHz for WebAudio
const BLOCK_SIZE        = 128;            // AudioWorklet render quantum (fixed by spec)
const SILENCE_THRESHOLD = 0.0001;         // RMS below this = silence / dropout
const FADE_ATTACK_MS    = 8;              // fade-in duration when audio resumes (ms)
const FADE_RELEASE_MS   = 12;            // fade-out duration on dropout start (ms)
const STATS_INTERVAL_BLOCKS = 400;        // post stats every ~1.07 s (400 × 2.67 ms)
const ALIVE_INTERVAL_BLOCKS = 1875;       // post 'alive' every ~5 s

class LiveStreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    // ── State ────────────────────────────────────────────────────────────
    this._targetGain    = 1.0;   // desired output gain (set by main thread)
    this._currentGain   = 0.0;   // smoothed current gain (ramps to _targetGain)
    this._isDropout     = false;  // true while we detect silence/dropout
    this._dropoutStart  = 0;     // sampleTime when last dropout began
    this._blockCount    = 0;     // render block counter for timed tasks
    this._rmsAccum      = 0;     // accumulated RMS² for stats window
    this._rmsCount      = 0;

    // Per-sample gain increment for attack/release envelopes
    this._attackInc  = 1.0 / (FADE_ATTACK_MS  * 0.001 * SAMPLE_RATE);
    this._releaseInc = 1.0 / (FADE_RELEASE_MS * 0.001 * SAMPLE_RATE);

    // ── Main-thread messages ──────────────────────────────────────────────
    this.port.onmessage = ({ data }) => {
      if (!data) return;
      switch (data.type) {
        case 'reset':
          this._currentGain   = 0.0;
          this._targetGain    = 1.0;
          this._isDropout     = false;
          this._dropoutStart  = 0;
          this._rmsAccum      = 0;
          this._rmsCount      = 0;
          break;
        case 'set-gain':
          this._targetGain = Math.max(0, Math.min(1, data.value));
          break;
      }
    };
  }

  /**
   * Called by the audio rendering thread every 128 samples.
   * MUST return true to keep the processor alive (returning false destroys it).
   */
  process(inputs, outputs) {
    const inputChannel0  = inputs[0]?.[0];   // left / mono
    const inputChannel1  = inputs[0]?.[1];   // right (may be undefined for mono)
    const outputChannel0 = outputs[0]?.[0];
    const outputChannel1 = outputs[0]?.[1];

    if (!inputChannel0 || !outputChannel0) return true;

    // ── Compute block RMS ─────────────────────────────────────────────────
    let rmsSum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      const s = inputChannel0[i];
      rmsSum += s * s;
    }
    const rms = Math.sqrt(rmsSum / BLOCK_SIZE);
    this._rmsAccum += rms;
    this._rmsCount++;

    // ── Dropout detection ─────────────────────────────────────────────────
    const wasSilent = this._isDropout;
    this._isDropout = rms < SILENCE_THRESHOLD;

    if (!wasSilent && this._isDropout) {
      // Dropout just started
      this._dropoutStart = currentTime;
      this.port.postMessage({ type: 'dropout-start' });
    } else if (wasSilent && !this._isDropout) {
      // Audio resumed after dropout
      const durationMs = (currentTime - this._dropoutStart) * 1000;
      this.port.postMessage({ type: 'dropout-end', durationMs });
    }

    // ── Apply gain with fade envelope ─────────────────────────────────────
    // When in dropout: ramp gain toward 0 (fade-out)
    // When playing:    ramp gain toward _targetGain (fade-in)
    const targetGain = this._isDropout ? 0.0 : this._targetGain;
    const inc        = this._isDropout ? -this._releaseInc : this._attackInc;

    for (let i = 0; i < BLOCK_SIZE; i++) {
      // Clamp gain to [0, 1]
      this._currentGain = Math.max(0.0, Math.min(1.0, this._currentGain + inc));
      const g = this._currentGain;

      outputChannel0[i] = inputChannel0[i] * g;
      if (outputChannel1 && inputChannel1) {
        outputChannel1[i] = inputChannel1[i] * g;
      } else if (outputChannel1) {
        outputChannel1[i] = inputChannel0[i] * g; // upmix mono → stereo
      }
    }

    // ── Periodic stats post ───────────────────────────────────────────────
    this._blockCount++;

    if (this._blockCount % STATS_INTERVAL_BLOCKS === 0) {
      const avgRms = this._rmsCount > 0 ? this._rmsAccum / this._rmsCount : 0;
      this._rmsAccum = 0;
      this._rmsCount = 0;
      this.port.postMessage({
        type:       'stats',
        rms:        avgRms,
        isDropout:  this._isDropout,
        fadeGain:   this._currentGain,
        sampleTime: currentTime,
      });
    }

    if (this._blockCount % ALIVE_INTERVAL_BLOCKS === 0) {
      this.port.postMessage({ type: 'alive' });
    }

    return true; // keep processor alive
  }
}

registerProcessor('live-stream-processor', LiveStreamProcessor);
