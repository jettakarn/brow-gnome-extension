import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const TAP_RATE = 16000;
export const TAP_WINDOW = 1024;
/** Band centres (Hz), low to high. Top end is capped by the 8 kHz Nyquist. */
export const BAND_CENTERS = [60, 150, 400, 1000, 2500, 6000];

const MIN_DB = -70;
const MAX_DB = -20;
const AGC_FLOOR = 0.45;
const AGC_DECAY = 0.996;
const DATA_FRESH_MS = 600;

const HANN = new Float32Array(TAP_WINDOW);
for (let i = 0; i < TAP_WINDOW; i++)
    HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (TAP_WINDOW - 1));

const COEFFS = BAND_CENTERS.map(f => {
    const k = Math.round((f * TAP_WINDOW) / TAP_RATE);
    return { k, coeff: 2 * Math.cos((2 * Math.PI * k) / TAP_WINDOW) };
});

function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

/**
 * Goertzel energy at each band centre, as dB mapped to 0..1
 * (same idea as AnalyserNode min/maxDecibels).
 * @param {Float32Array} frame TAP_WINDOW samples in -1..1, oldest first
 * @returns {number[]}
 */
export function analyzeFrame(frame) {
    const out = new Array(BAND_CENTERS.length);
    for (let b = 0; b < COEFFS.length; b++) {
        const { k, coeff } = COEFFS[b];
        let s1 = 0;
        let s2 = 0;
        for (let n = 0; n < TAP_WINDOW; n++) {
            const s0 = frame[n] * HANN[n] + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        const w = (2 * Math.PI * k) / TAP_WINDOW;
        const re = s1 - s2 * Math.cos(w);
        const im = s2 * Math.sin(w);
        // Hann coherent gain is 0.5, so a full-scale sine reads about 1.
        const amp = (4 * Math.sqrt(re * re + im * im)) / TAP_WINDOW;
        const db = 20 * Math.log10(amp + 1e-9);
        out[b] = Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
    }
    return out;
}

/**
 * Captures the default output monitor through parec (system output only,
 * never the microphone) and turns it into six band levels.
 */
export function createAudioTap() {
    const ring = new Float32Array(TAP_WINDOW);
    const frame = new Float32Array(TAP_WINDOW);
    const agc = new Array(BAND_CENTERS.length).fill(AGC_FLOOR);
    const levels = new Array(BAND_CENTERS.length).fill(0);

    let proc = null;
    let stream = null;
    let cancellable = null;
    let writePos = 0;
    let leftover = -1;
    let lastDataAt = 0;
    let lastSoundAt = 0;
    let startedAt = 0;

    function findParec() {
        return GLib.find_program_in_path('parec');
    }

    function push(u8) {
        const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let i = 0;
        const len = u8.byteLength;

        if (leftover >= 0 && len > 0) {
            const lo = leftover;
            const hi = view.getUint8(0);
            let v = (hi << 8) | lo;
            if (v & 0x8000)
                v -= 0x10000;
            ring[writePos] = v / 32768;
            writePos = (writePos + 1) % TAP_WINDOW;
            leftover = -1;
            i = 1;
        }
        let nonZero = false;
        for (; i + 1 < len; i += 2) {
            const raw16 = view.getInt16(i, true);
            if (raw16 !== 0)
                nonZero = true;
            ring[writePos] = raw16 / 32768;
            writePos = (writePos + 1) % TAP_WINDOW;
        }
        if (nonZero)
            lastSoundAt = nowMs();
        if (i < len)
            leftover = view.getUint8(i);
        lastDataAt = nowMs();
    }

    function readLoop(activeStream, activeCancellable) {
        activeStream.read_bytes_async(2048, GLib.PRIORITY_DEFAULT, activeCancellable, (s, res) => {
            let bytes;
            try {
                bytes = s.read_bytes_finish(res);
            } catch (e) {
                return;
            }
            if (!bytes || bytes.get_size() === 0)
                return;
            if (stream !== activeStream)
                return;
            push(bytes.toArray());
            readLoop(activeStream, activeCancellable);
        });
    }

    const tap = {
        available() {
            return !!findParec();
        },

        active() {
            return !!proc;
        },

        hasData() {
            return !!proc && lastDataAt > 0 && nowMs() - lastDataAt < DATA_FRESH_MS;
        },

        /** Milliseconds since the captured output was last non-silent. */
        silentForMs() {
            if (!proc)
                return 0;
            return nowMs() - (lastSoundAt || startedAt);
        },

        start() {
            if (proc)
                return true;
            const path = findParec();
            if (!path)
                return false;
            try {
                proc = Gio.Subprocess.new(
                    [
                        path,
                        '-d', '@DEFAULT_MONITOR@',
                        '--format=s16le',
                        `--rate=${TAP_RATE}`,
                        '--channels=1',
                        '--latency-msec=20',
                        '--client-name=brow-spectrum',
                    ],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
                );
            } catch (e) {
                proc = null;
                return false;
            }
            cancellable = new Gio.Cancellable();
            stream = proc.get_stdout_pipe();
            lastDataAt = 0;
            lastSoundAt = 0;
            startedAt = nowMs();
            leftover = -1;
            ring.fill(0);
            readLoop(stream, cancellable);
            const started = proc;
            started.wait_async(null, () => {
                if (proc === started)
                    tap.stop();
            });
            return true;
        },

        stop() {
            if (cancellable) {
                try {
                    cancellable.cancel();
                } catch (e) {
                    // ignore
                }
            }
            if (proc) {
                try {
                    proc.force_exit();
                } catch (e) {
                    // ignore
                }
            }
            proc = null;
            stream = null;
            cancellable = null;
            lastDataAt = 0;
            levels.fill(0);
            agc.fill(AGC_FLOOR);
        },

        /** Six 0..1 levels from the newest TAP_WINDOW samples. */
        bands() {
            for (let i = 0; i < TAP_WINDOW; i++)
                frame[i] = ring[(writePos + i) % TAP_WINDOW];
            const raw = analyzeFrame(frame);
            for (let b = 0; b < raw.length; b++) {
                agc[b] = Math.max(raw[b], agc[b] * AGC_DECAY, AGC_FLOOR);
                levels[b] = Math.max(0, Math.min(1, raw[b] / agc[b]));
                // Quiet bands should stay quiet: scale by absolute level too.
                levels[b] *= Math.min(1, 0.25 + raw[b] * 1.6);
            }
            return levels;
        },
    };

    return tap;
}
