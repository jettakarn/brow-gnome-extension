import GLib from 'gi://GLib';

export const SPECTRUM_BANDS = 6;

/** Web Audio style smoothingTimeConstant for the falling edge. */
export const SMOOTHING_TIME_CONSTANT = 0.8;
const FRAME_MS = 33;
const TAP_START_GRACE_MS = 1500;
const TAP_RETRY_MS = 30000;
const NEIGHBOR_BLEED = 0.12;
/** Captured output that stays pure silence this long (muted sink) uses the simulation. */
const SILENCE_FALLBACK_MS = 1200;

function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

// ---- 1D gradient-style value noise (Perlin flavoured) -------------------

function hash01(n) {
    let x = (n | 0) * 374761393 + 668265263;
    x = (x ^ (x >>> 13)) * 1274126177;
    x = x ^ (x >>> 16);
    return ((x >>> 0) % 100000) / 100000;
}

function noise1(x) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash01(i) * (1 - u) + hash01(i + 1) * u;
}

const clamp01 = v => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
};

/** Distance in beats to the nearest hit of a repeating pattern. */
function beatDistance(beatPos, hits, bar = 4) {
    let best = bar;
    for (const h of hits) {
        let d = Math.abs(beatPos - h);
        d = Math.min(d, bar - d);
        if (d < best)
            best = d;
    }
    return best;
}

/**
 * Simulated spectrum: layered sines modulated by smooth noise.
 * Band order is low to high, like the real analysis.
 * @param {number} tSec
 * @returns {number[]} six values in 0..1
 */
export function simulateBands(tSec) {
    const bpm = 96;
    const beat = (tSec * bpm / 60) % 4;

    const kick = Math.exp(-beatDistance(beat, [0, 2, 2.75]) * 9);
    const snare = Math.exp(-beatDistance(beat, [1, 3]) * 11);
    const hat = Math.exp(-beatDistance((beat * 2) % 4, [0, 1, 2, 3]) * 6);

    // Vocal phrase gate: voice comes and goes in phrases of a few seconds.
    const phrase = smoothstep(0.35, 0.6, noise1(tSec * 0.35 + 11.3));
    const syllable = 0.5 + 0.5 * Math.sin(tSec * Math.PI * 2 * 3.7 + noise1(tSec * 0.8) * 6);
    const voice = phrase * (0.35 + 0.65 * syllable) * (0.6 + 0.4 * noise1(tSec * 2.2 + 3));

    const bassLine = (0.5 + 0.5 * Math.sin(tSec * Math.PI * 2 * 0.52)) * noise1(tSec * 1.3 + 7);

    const out = [
        kick * 0.95 + 0.12 * noise1(tSec * 6),
        kick * 0.55 + bassLine * 0.4 + 0.08 * noise1(tSec * 5 + 20),
        voice * 0.85 + snare * 0.2 + 0.06 * noise1(tSec * 7 + 40),
        voice * (0.65 + 0.2 * Math.sin(tSec * 9.1)) + snare * 0.35 + 0.05 * noise1(tSec * 8 + 60),
        voice * 0.4 + snare * 0.6 + hat * 0.25 + 0.06 * noise1(tSec * 9 + 80),
        hat * 0.7 + snare * 0.25 + 0.12 * noise1(tSec * 14 + 100),
    ];
    return out.map(v => clamp01(v));
}

/**
 * Shared spectrum engine. One engine drives every spectrum view.
 *
 * @param {{ tap?: object, getMode?: () => string }} opts
 *   tap: audio tap with start(), stop(), bands(), active(), hasData().
 *   getMode: returns 'auto' (real audio first) or 'simulated'.
 */
export function createSpectrumEngine({ tap = null, getMode = () => 'auto' } = {}) {
    const pos = new Array(SPECTRUM_BANDS).fill(0);
    const vel = new Array(SPECTRUM_BANDS).fill(0);
    const smooth = new Array(SPECTRUM_BANDS).fill(0);
    const out = new Array(SPECTRUM_BANDS).fill(0);

    let timeMs = 0;
    let tapStartedAt = 0;
    let tapBlockedUntil = 0;
    let lastSource = 'none';

    function wantTap(playing) {
        return !!tap && playing && getMode() === 'auto' && nowMs() >= tapBlockedUntil;
    }

    function targetBands(playing) {
        if (!playing)
            return null;

        if (wantTap(playing)) {
            if (!tap.active()) {
                if (tap.start())
                    tapStartedAt = nowMs();
                else
                    tapBlockedUntil = nowMs() + TAP_RETRY_MS;
            }
            if (tap.active()) {
                if (tap.hasData()) {
                    if (tap.silentForMs() < SILENCE_FALLBACK_MS) {
                        lastSource = 'audio';
                        return tap.bands();
                    }
                    lastSource = 'simulated-silent';
                    return simulateBands(timeMs / 1000);
                }
                if (nowMs() - tapStartedAt > TAP_START_GRACE_MS) {
                    tap.stop();
                    tapBlockedUntil = nowMs() + TAP_RETRY_MS;
                }
            }
        } else if (tap?.active()) {
            tap.stop();
        }

        lastSource = 'simulated';
        return simulateBands(timeMs / 1000);
    }

    return {
        get source() {
            return lastSource;
        },

        /**
         * Advance physics by dtMs and return six 0..1 levels.
         * Not playing: targets fall to 0 so bars shrink to dots.
         */
        step(playing, dtMs = FRAME_MS) {
            const k = Math.max(0.25, Math.min(3, dtMs / FRAME_MS));
            timeMs += dtMs;

            if (!playing && tap?.active())
                tap.stop();

            const target = targetBands(playing);
            const decay = Math.pow(SMOOTHING_TIME_CONSTANT, k);

            for (let i = 0; i < SPECTRUM_BANDS; i++) {
                const t = target ? clamp01(target[i]) : 0;
                // Fast attack, slow decay (analyser smoothing on the way down).
                if (t > smooth[i])
                    smooth[i] += (t - smooth[i]) * Math.min(1, 0.65 * k);
                else
                    smooth[i] = decay * smooth[i] + (1 - decay) * t;
            }

            for (let i = 0; i < SPECTRUM_BANDS; i++) {
                const left = smooth[i - 1] ?? smooth[i];
                const right = smooth[i + 1] ?? smooth[i];
                const goal = clamp01(smooth[i] + NEIGHBOR_BLEED * ((left + right) / 2 - smooth[i]) * 2 * (target ? 1 : 0));
                const diff = goal - pos[i];
                // Light spring with ease-out damping: no constant-speed motion.
                const stiffness = diff > 0 ? 0.42 : 0.2;
                vel[i] = vel[i] * Math.pow(0.5, k) + diff * stiffness * k;
                pos[i] = clamp01(pos[i] + vel[i]);
                out[i] = pos[i];
            }
            return out;
        },

        /** True once every bar rests as a dot and nothing moves. */
        isSettled() {
            for (let i = 0; i < SPECTRUM_BANDS; i++) {
                if (pos[i] > 0.012 || Math.abs(vel[i]) > 0.004 || smooth[i] > 0.012)
                    return false;
            }
            return true;
        },

        stopAudio() {
            tap?.stop();
        },

        destroy() {
            tap?.stop();
        },
    };
}
