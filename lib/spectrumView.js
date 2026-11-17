import St from 'gi://St';

export const SPECTRUM_BARS = 6;
export const SPECTRUM_BAR_WIDTH = 3;
export const SPECTRUM_GAP = 2.5;

const DEFAULT_TOP = { r: 244, g: 114, b: 182 };
const DEFAULT_BOTTOM = { r: 139, g: 92, b: 246 };

function mix(a, b, t) {
    return {
        r: Math.round(a.r + (b.r - a.r) * t),
        g: Math.round(a.g + (b.g - a.g) * t),
        b: Math.round(a.b + (b.b - a.b) * t),
    };
}

const rgb = c => `rgb(${c.r}, ${c.g}, ${c.b})`;

/**
 * Six pill bars. Each bar is one rounded actor with a vertical gradient and
 * a soft glow. Height 3 (equal to the width) renders as a perfect dot.
 *
 * @param {{ boxSize?: number, maxHeight?: number, minHeight?: number }} opts
 */
export function createSpectrumView({ boxSize = 32, maxHeight = 28, minHeight = SPECTRUM_BAR_WIDTH } = {}) {
    const actor = new St.Widget({
        style_class: 'brow-spectrum',
        width: boxSize,
        height: boxSize,
        x_expand: false,
        y_expand: false,
        reactive: false,
    });

    const total = SPECTRUM_BARS * SPECTRUM_BAR_WIDTH + (SPECTRUM_BARS - 1) * SPECTRUM_GAP;
    const offset = (boxSize - total) / 2;
    const bars = [];
    for (let i = 0; i < SPECTRUM_BARS; i++) {
        const bar = new St.Widget({
            style_class: 'brow-spectrum-bar',
            width: SPECTRUM_BAR_WIDTH,
            height: minHeight,
            reactive: false,
        });
        bar.set_position(
            Math.round(offset + i * (SPECTRUM_BAR_WIDTH + SPECTRUM_GAP)),
            Math.round((boxSize - minHeight) / 2)
        );
        actor.add_child(bar);
        bars.push(bar);
    }

    const heights = new Array(SPECTRUM_BARS).fill(minHeight);

    const view = {
        actor,

        /** Gradient from a cover color: light at the top, deep at the bottom. */
        setColor(color) {
            const base = color ?? null;
            const top = base ? mix(base, { r: 255, g: 255, b: 255 }, 0.45) : DEFAULT_TOP;
            const bottom = base ? mix(base, { r: 0, g: 0, b: 0 }, 0.35) : DEFAULT_BOTTOM;
            const glow = base ?? mix(DEFAULT_TOP, DEFAULT_BOTTOM, 0.5);
            const style =
                'border-radius: 999px; ' +
                'background-gradient-direction: vertical; ' +
                `background-gradient-start: ${rgb(top)}; ` +
                `background-gradient-end: ${rgb(bottom)}; ` +
                `box-shadow: 0 0 6px rgba(${glow.r}, ${glow.g}, ${glow.b}, 0.5);`;
            for (const bar of bars) {
                try {
                    bar.set_style(style);
                } catch (e) {
                    // actor gone
                }
            }
        },

        /** levels: array of 0..1 (one per bar). */
        render(levels) {
            const span = Math.max(0, maxHeight - minHeight);
            for (let i = 0; i < SPECTRUM_BARS; i++) {
                const lvl = Math.max(0, Math.min(1, levels[i] ?? 0));
                const h = Math.max(minHeight, Math.round(minHeight + lvl * span));
                if (h === heights[i])
                    continue;
                heights[i] = h;
                try {
                    bars[i].set_height(h);
                    bars[i].set_y(Math.round((boxSize - h) / 2));
                } catch (e) {
                    // actor gone mid-tick
                }
            }
        },

        destroy() {
            try {
                actor.destroy();
            } catch (e) {
                // ignore
            }
        },
    };

    view.setColor(null);
    return view;
}
