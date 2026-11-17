import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

const TIMER_PRESETS_MIN = [5, 15, 25, 45];
const RING_SIZE = 16;
const SPARK_POINTS = 30;
const SPARK_W = 120;
const SPARK_H = 28;
const NOTICE_TIMER_DONE_MS = 8000;

function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

/** CPU busy fraction between two /proc/stat reads. */
function readCpuTimes() {
    const text = readText('/proc/stat');
    if (!text)
        return null;
    const line = text.split('\n', 1)[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 5)
        return null;
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
}

function readMemoryPct() {
    const text = readText('/proc/meminfo');
    if (!text)
        return null;
    const total = /MemTotal:\s+(\d+)/.exec(text)?.[1];
    const avail = /MemAvailable:\s+(\d+)/.exec(text)?.[1];
    if (!total || !avail)
        return null;
    return Math.round(100 * (1 - Number(avail) / Number(total)));
}

function readTemperatureC() {
    let best = null;
    for (let i = 0; i < 12; i++) {
        const type = readText(`/sys/class/thermal/thermal_zone${i}/type`);
        if (type == null)
            continue;
        const raw = readText(`/sys/class/thermal/thermal_zone${i}/temp`);
        const value = raw ? Number(raw.trim()) / 1000 : NaN;
        if (!Number.isFinite(value) || value <= 0 || value > 130)
            continue;
        const t = type.trim();
        if (t === 'x86_pkg_temp' || t === 'k10temp' || t.startsWith('cpu'))
            return Math.round(value);
        if (best == null || value > best)
            best = value;
    }
    return best == null ? null : Math.round(best);
}

function makeChip(label, onClick) {
    const btn = new St.Button({
        label,
        style_class: 'brow-settings-chip',
        reactive: false,
        can_focus: false,
    });
    btn.connect('clicked', onClick);
    return btn;
}

export function buildToolsTab(host) {
    const tab = new St.Bin({
        style_class: 'brow-tools-tab',
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
        opacity: 0,
        translation_x: 50,
        reactive: false,
        clip_to_allocation: true,
    });

    const columns = new St.BoxLayout({
        vertical: false,
        x_expand: true,
        y_expand: true,
        style_class: 'brow-tools-columns',
    });

    // Timer column
    const timerCol = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'brow-tools-col',
    });
    timerCol.add_child(new St.Label({ text: 'Timer', style_class: 'brow-settings-section' }));
    const timerValue = new St.Label({
        text: '--:--',
        style_class: 'brow-tools-timer',
        x_align: Clutter.ActorAlign.START,
    });
    const timerHint = new St.Label({
        text: 'Pick a duration',
        style_class: 'brow-tools-hint',
        x_align: Clutter.ActorAlign.START,
    });
    timerCol.add_child(timerValue);
    timerCol.add_child(timerHint);

    const presetRow = new St.BoxLayout({ style_class: 'brow-tools-chips' });
    const buttons = [];
    for (const min of TIMER_PRESETS_MIN) {
        const b = makeChip(`${min}m`, () => startTimer(host, min * 60 * 1000));
        buttons.push(b);
        presetRow.add_child(b);
    }
    const cancelBtn = makeChip('Cancel', () => cancelTimer(host));
    buttons.push(cancelBtn);
    cancelBtn.visible = false;
    timerCol.add_child(presetRow);
    timerCol.add_child(cancelBtn);

    // System column
    const sysCol = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'brow-tools-col',
    });
    sysCol.add_child(new St.Label({ text: 'System', style_class: 'brow-settings-section' }));
    const cpuLabel = new St.Label({ text: 'CPU --%', style_class: 'brow-tools-stat' });
    const spark = new St.DrawingArea({ width: SPARK_W, height: SPARK_H, style_class: 'brow-tools-spark' });
    const memLabel = new St.Label({ text: 'Memory --%', style_class: 'brow-tools-stat' });
    const tempLabel = new St.Label({ text: 'Temp --', style_class: 'brow-tools-stat' });
    sysCol.add_child(cpuLabel);
    sysCol.add_child(spark);
    sysCol.add_child(memLabel);
    sysCol.add_child(tempLabel);

    columns.add_child(timerCol);
    columns.add_child(sysCol);
    tab.set_child(columns);

    const history = [];
    spark.connect('repaint', area => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.moveTo(0, h - 0.5);
        cr.lineTo(w, h - 0.5);
        cr.stroke();
        if (history.length > 1) {
            cr.setSourceRGBA(1, 1, 1, 0.9);
            const step = w / (SPARK_POINTS - 1);
            const offset = SPARK_POINTS - history.length;
            history.forEach((v, i) => {
                const x = (offset + i) * step;
                const y = h - 2 - (h - 4) * Math.max(0, Math.min(1, v));
                if (i === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            });
            cr.stroke();
        }
        cr.$dispose();
    });

    // Ring in the closed island
    const ring = new St.DrawingArea({
        width: RING_SIZE,
        height: RING_SIZE,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        opacity: 0,
        reactive: false,
        margin_right: 26,
    });
    ring.connect('repaint', area => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const r = Math.min(w, h) / 2 - 2;
        const cx = w / 2;
        const cy = h / 2;
        const frac = timerFraction(host);
        cr.setLineWidth(2);
        cr.setSourceRGBA(1, 1, 1, 0.2);
        cr.arc(cx, cy, r, 0, Math.PI * 2);
        cr.stroke();
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        cr.stroke();
        cr.$dispose();
    });

    host._tools = {
        tab,
        buttons,
        cancelBtn,
        presetRow,
        timerValue,
        timerHint,
        cpuLabel,
        memLabel,
        tempLabel,
        spark,
        history,
        ring,
        timer: null,
        timerSourceId: 0,
        sysSourceId: 0,
        cpuPrev: null,
    };
    host._toolsTab = tab;
    host._timerRing = ring;
    return tab;
}

function timerFraction(host) {
    const t = host._tools?.timer;
    if (!t)
        return 0;
    return Math.max(0, Math.min(1, (t.endMs - nowMs()) / t.totalMs));
}

export function setToolsReactive(host, on) {
    const t = host._tools;
    if (!t)
        return;
    for (const b of t.buttons) {
        b.reactive = !!on;
        b.can_focus = !!on;
    }
    if (on)
        startSysmon(host);
    else
        stopSysmon(host);
}

function refreshTimerUi(host) {
    const t = host._tools;
    if (!t)
        return;
    const running = !!t.timer;
    t.cancelBtn.visible = running;
    t.presetRow.visible = !running;
    if (running) {
        t.timerValue.set_text(formatClock(t.timer.endMs - nowMs()));
        t.timerHint.set_text('Running');
    } else {
        t.timerValue.set_text('--:--');
        t.timerHint.set_text('Pick a duration');
    }
    t.ring.queue_repaint();
    syncTimerRing(host);
}

export function startTimer(host, durationMs) {
    const t = host._tools;
    if (!t)
        return;
    cancelTimer(host, { silent: true });
    t.timer = { totalMs: durationMs, endMs: nowMs() + durationMs };
    t.timerSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        if (!host._tools?.timer) {
            t.timerSourceId = 0;
            return GLib.SOURCE_REMOVE;
        }
        if (nowMs() >= t.timer.endMs) {
            t.timerSourceId = 0;
            finishTimer(host);
            return GLib.SOURCE_REMOVE;
        }
        refreshTimerUi(host);
        return GLib.SOURCE_CONTINUE;
    });
    refreshTimerUi(host);
}

export function cancelTimer(host, { silent = false } = {}) {
    const t = host._tools;
    if (!t)
        return;
    if (t.timerSourceId) {
        GLib.source_remove(t.timerSourceId);
        t.timerSourceId = 0;
    }
    t.timer = null;
    if (!silent)
        refreshTimerUi(host);
}

function finishTimer(host) {
    const t = host._tools;
    const minutes = Math.round((t?.timer?.totalMs ?? 0) / 60000);
    t.timer = null;
    refreshTimerUi(host);
    host._showNotice?.({
        title: 'Timer done',
        body: `${minutes} minute${minutes === 1 ? '' : 's'} elapsed`,
        iconName: 'alarm-symbolic',
        holdMs: NOTICE_TIMER_DONE_MS,
    });
}

/** Ring is visible only when the island is closed, idle, and a timer runs. */
export function syncTimerRing(host) {
    const t = host._tools;
    if (!t?.ring)
        return;
    const show = !!t.timer &&
        !host._isExpanded &&
        !host._hoverActive &&
        !host._isPlaying &&
        !host._isTransientHud?.();
    const target = show ? 255 : 0;
    if (t.ring.opacity === target)
        return;
    t.ring.ease({
        opacity: target,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}

function sampleSystem(host) {
    const t = host._tools;
    if (!t)
        return;

    const cur = readCpuTimes();
    if (cur && t.cpuPrev) {
        const dTotal = cur.total - t.cpuPrev.total;
        const dIdle = cur.idle - t.cpuPrev.idle;
        const busy = dTotal > 0 ? Math.max(0, Math.min(1, 1 - dIdle / dTotal)) : 0;
        t.history.push(busy);
        while (t.history.length > SPARK_POINTS)
            t.history.shift();
        t.cpuLabel.set_text(`CPU ${Math.round(busy * 100)}%`);
        t.spark.queue_repaint();
    }
    t.cpuPrev = cur;

    const mem = readMemoryPct();
    t.memLabel.set_text(mem == null ? 'Memory --' : `Memory ${mem}%`);
    const temp = readTemperatureC();
    t.tempLabel.set_text(temp == null ? 'Temp --' : `Temp ${temp}\u00b0C`);
}

function startSysmon(host) {
    const t = host._tools;
    if (!t || t.sysSourceId || host._currentTab !== 5)
        return;
    t.cpuPrev = readCpuTimes();
    sampleSystem(host);
    t.sysSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        sampleSystem(host);
        return GLib.SOURCE_CONTINUE;
    });
}

function stopSysmon(host) {
    const t = host._tools;
    if (!t?.sysSourceId)
        return;
    GLib.source_remove(t.sysSourceId);
    t.sysSourceId = 0;
    t.cpuPrev = null;
}

export function destroyTools(host) {
    const t = host._tools;
    if (!t)
        return;
    cancelTimer(host, { silent: true });
    stopSysmon(host);
    host._tools = null;
    host._toolsTab = null;
    host._timerRing = null;
}
