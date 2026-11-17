import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import GdkPixbuf from 'gi://GdkPixbuf';
import { createSpectrumView } from './spectrumView.js';
import { createSpectrumEngine } from './spectrumEngine.js';
import { createAudioTap } from './audioTap.js';
import {
    ALBUM_SIZE,
    QUICK_ART_SIZE,
    MEDIA_PLAYER_ART_SIZE,
    PROGRESS_POLL_MS,
    WAVE_TICK_MS,
    WAVE_H_MAX,
    WAVE_H_MAX_CARD,
    WAVE_BOX_SIZE,
} from './constants.js';

function findPlayerctl() {
    let path = GLib.find_program_in_path('playerctl');
    if (path)
        return path;
    const localBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'playerctl']);
    if (GLib.file_test(localBin, GLib.FileTest.IS_EXECUTABLE))
        return localBin;
    return null;
}

function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return '0:00';
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}

function makeCtrlButton(iconName, onClick, iconSize = 28) {
    const icon = new St.Icon({
        icon_name: iconName,
        style_class: 'brow-media-ctrl-icon',
        icon_size: iconSize,
    });
    const btn = new St.Button({
        style_class: 'brow-media-ctrl-btn',
        child: icon,
        reactive: false,
        can_focus: false,
    });
    btn._browIcon = icon;
    btn.connect('clicked', () => onClick());
    return btn;
}

function fileToCssUrl(file) {
    const uri = file.get_uri();
    return `url("${uri.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

function boostVisibleColor(r, g, b) {
    const max = Math.max(r, g, b);
    if (max < 150) {
        const scale = 150 / Math.max(max, 1);
        r = Math.min(255, Math.round(r * scale));
        g = Math.min(255, Math.round(g * scale));
        b = Math.min(255, Math.round(b * scale));
    }
    return { r, g, b };
}

/** Pick a vivid color from album art for spectrum tinting. */
function extractArtColor(file) {
    try {
        const path = file.get_path();
        if (!path)
            return { r: 255, g: 255, b: 255 };
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 40, 40);
        const pixels = pb.get_pixels();
        const nCh = pb.get_n_channels();
        const stride = pb.get_rowstride();
        const w = pb.get_width();
        const h = pb.get_height();

        let bestScore = -1;
        let best = { r: 255, g: 255, b: 255 };

        for (let y = 0; y < h; y += 2) {
            for (let x = 0; x < w; x += 2) {
                const i = y * stride + x * nCh;
                const r = pixels[i];
                const g = pixels[i + 1];
                const b = pixels[i + 2];
                const mx = Math.max(r, g, b);
                const mn = Math.min(r, g, b);
                const lum = (r + g + b) / 3;
                if (lum < 28 || lum > 245 || mx < 20)
                    continue;
                const sat = mx === 0 ? 0 : (mx - mn) / mx;
                const score = sat * 2.0 + (lum / 255) * 0.35;
                if (score > bestScore) {
                    bestScore = score;
                    best = { r, g, b };
                }
            }
        }
        return boostVisibleColor(best.r, best.g, best.b);
    } catch (e) {
        return { r: 255, g: 255, b: 255 };
    }
}

/** St.Icon ignores border-radius; CSS background-image clips to radius. */
function makeAlbumStack(size, noteSize) {
    const placeholder = new St.Bin({
        style_class: 'brow-album-placeholder',
        width: size,
        height: size,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
    });
    placeholder.set_child(new St.Icon({
        icon_name: 'audio-x-generic-symbolic',
        style_class: 'brow-album-note',
        icon_size: noteSize,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    }));

    const cover = new St.Widget({
        style_class: 'brow-album-cover',
        width: size,
        height: size,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
        visible: false,
    });

    const stack = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        width: size,
        height: size,
        style_class: 'brow-album-art',
    });
    stack.add_child(placeholder);
    stack.add_child(cover);
    return { stack, placeholder, cover };
}

/**
 * Media tab + playerctl state. Binds onto an extension-like host for shared fields.
 */
export class MediaController {
    constructor(host) {
        this._host = host;
        this._playerctlPath = findPlayerctl();
        this._soup = host._soup;
        this._busy = false;
        this._artUrl = null;
        this._artTmpPath = null;
        this._trackLengthSec = 0;
        this._positionSec = 0;
        this._progressSource = null;
        this._metaSource = null;
        this._waveSource = null;
        this._spectrumViews = [];
        this._lastWaveTickMs = 0;
        this._spectrum = createSpectrumEngine({
            tap: createAudioTap(),
            getMode: () => {
                try {
                    return this._host._settings?.get_string('spectrum-source') ?? 'auto';
                } catch (e) {
                    return 'auto';
                }
            },
        });
        this._artCovers = [];
    }

    get playerctlPath() {
        return this._playerctlPath;
    }

    buildQuickStrip() {
        const box = new St.BoxLayout({
            style_class: 'brow-media-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });

        const album = makeAlbumStack(QUICK_ART_SIZE, 14);
        this._quickPlaceholder = album.placeholder;
        this._quickCover = album.cover;
        this._artCovers.push(album.cover);

        const spacer = new St.Widget({ x_expand: true });

        const wave = this._addSpectrum(WAVE_H_MAX);

        box.add_child(album.stack);
        box.add_child(spacer);
        box.add_child(wave);
        return box;
    }

    _bindAlbumHit(stack) {
        stack.reactive = false;
        // Toggle on release, while this actor still owns the gesture.
        // Stopping both events keeps the island from collapsing.
        stack.connect('button-press-event', () => Clutter.EVENT_STOP);
        stack.connect('button-release-event', () => {
            this._host.toggleMediaPlayer?.();
            return Clutter.EVENT_STOP;
        });
        this._albumHits.push(stack);
    }

    buildTab() {
        const tab = new St.BoxLayout({
            style_class: 'brow-media-tab',
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            translation_x: 50,
            reactive: false,
        });
        this._mediaTabRoot = tab;
        this._playerMode = false;
        this._albumHits = [];

        const header = new St.BoxLayout({
            style_class: 'brow-media-header',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const album = makeAlbumStack(ALBUM_SIZE, 22);
        this._albumStack = album.stack;
        this._albumPlaceholder = album.placeholder;
        this._albumCover = album.cover;
        this._artCovers.push(album.cover);
        this._bindAlbumHit(album.stack);

        const metaCol = new St.BoxLayout({
            style_class: 'brow-media-meta',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaMeta = metaCol;
        this._cardTitle = new St.Label({
            text: 'not playing',
            style_class: 'brow-card-title',
        });
        this._cardArtist = new St.Label({
            text: '—',
            style_class: 'brow-card-artist',
        });
        metaCol.add_child(this._cardTitle);
        metaCol.add_child(this._cardArtist);

        const wave = this._addSpectrum(WAVE_H_MAX_CARD);

        header.add_child(album.stack);
        header.add_child(metaCol);
        header.add_child(wave);

        const progressBlock = new St.BoxLayout({
            style_class: 'brow-progress-block',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._progressBlock = progressBlock;

        const progressRow = new St.BoxLayout({
            style_class: 'brow-progress-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._progressRow = progressRow;
        this._elapsedLabel = new St.Label({
            text: '0:00',
            style_class: 'brow-progress-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._remainingLabel = new St.Label({
            text: '0:00',
            style_class: 'brow-progress-time',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const barH = 4;
        const hitH = 20;
        this._progressFill = new St.Widget({
            style_class: 'brow-progress-fill',
            height: barH,
            width: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const trackStack = new St.Widget({
            style_class: 'brow-progress-hit',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            height: hitH,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            track_hover: true,
        });
        const trackBg = new St.Widget({
            style_class: 'brow-progress-track',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: barH,
        });
        const fillRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: barH,
        });
        fillRow.add_child(this._progressFill);
        trackStack.add_child(trackBg);
        trackStack.add_child(fillRow);
        this._progressTrackStack = trackStack;
        this._progressScrubbing = false;
        this._progressStageId = 0;

        const clearStageGrab = () => {
            if (this._progressStageId) {
                try {
                    global.stage.disconnect(this._progressStageId);
                } catch (e) {
                    // ignore
                }
                this._progressStageId = 0;
            }
        };

        const endScrub = () => {
            if (!this._progressScrubbing)
                return;
            this._progressScrubbing = false;
            clearStageGrab();
            this._pollPosition();
        };

        trackStack.connect('button-press-event', (_a, event) => {
            this._progressScrubbing = true;
            this._seekFromEvent(trackStack, event);
            clearStageGrab();
            this._progressStageId = global.stage.connect('captured-event', (_s, ev) => {
                const type = ev.type();
                if (type === Clutter.EventType.MOTION && this._progressScrubbing) {
                    this._seekFromEvent(trackStack, ev);
                } else if (type === Clutter.EventType.BUTTON_RELEASE) {
                    endScrub();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_STOP;
        });
        trackStack.connect('button-release-event', () => {
            endScrub();
            return Clutter.EVENT_STOP;
        });

        progressRow.add_child(this._elapsedLabel);
        progressRow.add_child(trackStack);
        progressRow.add_child(this._remainingLabel);
        progressBlock.add_child(progressRow);

        const controls = new St.BoxLayout({
            style_class: 'brow-media-buttons',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaControls = controls;

        const centerBtns = new St.BoxLayout({
            style_class: 'brow-media-buttons-center',
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaCenterBtns = centerBtns;

        this._btnPrev = makeCtrlButton('media-skip-backward-symbolic', () => this.cmd('previous'), 28);
        this._btnPlay = makeCtrlButton('media-playback-start-symbolic', () => this.cmd('play-pause'), 32);
        this._btnNext = makeCtrlButton('media-skip-forward-symbolic', () => this.cmd('next'), 28);
        centerBtns.add_child(this._btnPrev);
        centerBtns.add_child(this._btnPlay);
        centerBtns.add_child(this._btnNext);

        const openSound = () => {
            try {
                GLib.spawn_command_line_async('gnome-control-center sound');
            } catch (e) {
                console.error('Failed to open sound settings:', e);
            }
        };

        this._btnOutput = makeCtrlButton('audio-headphones-symbolic', openSound, 24);
        this._btnOutput.style_class = 'brow-media-ctrl-btn brow-media-output-btn';

        controls.add_child(centerBtns);
        controls.add_child(this._btnOutput);

        // Large-player volume row (hidden in compact)
        const volumeRow = new St.BoxLayout({
            style_class: 'brow-media-volume-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._volumeRow = volumeRow;

        const volLow = new St.Icon({
            icon_name: 'audio-volume-low-symbolic',
            style_class: 'brow-media-volume-icon',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const volHigh = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            style_class: 'brow-media-volume-icon',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const volBarH = 4;
        const volHitH = 22;
        this._volumeFill = new St.Widget({
            style_class: 'brow-media-volume-fill',
            height: volBarH,
            width: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const volFillRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: volBarH,
        });
        volFillRow.add_child(this._volumeFill);
        const volTrackBg = new St.Widget({
            style_class: 'brow-media-volume-track',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: volBarH,
        });
        const volHit = new St.Widget({
            style_class: 'brow-media-volume-hit',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            height: volHitH,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            track_hover: true,
        });
        volHit.add_child(volTrackBg);
        volHit.add_child(volFillRow);
        this._volumeTrackHit = volHit;
        this._volumeScrubbing = false;
        this._volumeStageId = 0;

        const clearVolStage = () => {
            if (this._volumeStageId) {
                try {
                    global.stage.disconnect(this._volumeStageId);
                } catch (e) {
                    // ignore
                }
                this._volumeStageId = 0;
            }
        };

        const endVolScrub = () => {
            if (!this._volumeScrubbing)
                return;
            this._volumeScrubbing = false;
            clearVolStage();
        };

        volHit.connect('button-press-event', (_a, event) => {
            this._volumeScrubbing = true;
            const ratio = this._ratioFromEvent(volHit, event);
            this._host._setOutputVolumeRatio?.(ratio, { showHud: false });
            clearVolStage();
            this._volumeStageId = global.stage.connect('captured-event', (_s, ev) => {
                const type = ev.type();
                if (type === Clutter.EventType.MOTION && this._volumeScrubbing) {
                    const r = this._ratioFromEvent(volHit, ev);
                    this._host._setOutputVolumeRatio?.(r, { showHud: false });
                } else if (type === Clutter.EventType.BUTTON_RELEASE) {
                    endVolScrub();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_STOP;
        });
        volHit.connect('button-release-event', () => {
            endVolScrub();
            return Clutter.EVENT_STOP;
        });

        volumeRow.add_child(volLow);
        volumeRow.add_child(volHit);
        volumeRow.add_child(volHigh);

        const pillInner = new St.BoxLayout({
            style_class: 'brow-media-output-pill-inner',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        pillInner.add_child(new St.Icon({
            icon_name: 'audio-headphones-symbolic',
            style_class: 'brow-media-output-pill-icon',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        pillInner.add_child(new St.Label({
            text: 'Sound',
            style_class: 'brow-media-output-pill-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const outputPill = new St.Button({
            style_class: 'brow-media-output-pill',
            child: pillInner,
            reactive: false,
            can_focus: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        outputPill.connect('clicked', openSound);
        this._btnOutputPill = outputPill;

        const pillWrap = new St.Bin({
            style_class: 'brow-media-output-pill-wrap',
            child: outputPill,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const compact = new St.BoxLayout({
            style_class: 'brow-media-compact',
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        compact.add_child(header);
        compact.add_child(progressBlock);
        compact.add_child(controls);
        this._compactColumn = compact;

        const playerArt = makeAlbumStack(MEDIA_PLAYER_ART_SIZE, 48);
        playerArt.stack.add_style_class_name('brow-album-art-player');
        this._artCovers.push(playerArt.cover);
        this._bindAlbumHit(playerArt.stack);

        const artWrap = new St.Bin({
            child: playerArt.stack,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const playerMeta = new St.BoxLayout({
            style_class: 'brow-media-player-meta',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._playerTitle = new St.Label({
            text: this._cardTitle?.get_text?.() || 'not playing',
            style_class: 'brow-card-title brow-card-title-player',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._playerArtist = new St.Label({
            text: this._cardArtist?.get_text?.() || '—',
            style_class: 'brow-card-artist',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        playerMeta.add_child(this._playerTitle);
        playerMeta.add_child(this._playerArtist);

        const playerWave = this._addSpectrum(WAVE_H_MAX_CARD);
        const playerHead = new St.BoxLayout({
            style_class: 'brow-media-player-head',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        playerHead.add_child(playerMeta);
        playerHead.add_child(playerWave);

        const playerBarH = 4;
        const playerHitH = 20;
        this._playerProgressFill = new St.Widget({
            style_class: 'brow-progress-fill',
            height: playerBarH,
            width: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const playerFillRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: playerBarH,
        });
        playerFillRow.add_child(this._playerProgressFill);
        const playerTrackBg = new St.Widget({
            style_class: 'brow-progress-track',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            height: playerBarH,
        });
        const playerTrack = new St.Widget({
            style_class: 'brow-progress-hit',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            height: playerHitH,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            track_hover: true,
        });
        playerTrack.add_child(playerTrackBg);
        playerTrack.add_child(playerFillRow);
        this._playerProgressTrack = playerTrack;

        playerTrack.connect('button-press-event', (_a, event) => {
            this._progressScrubbing = true;
            this._seekFromEvent(playerTrack, event);
            clearStageGrab();
            this._progressStageId = global.stage.connect('captured-event', (_s, ev) => {
                const type = ev.type();
                if (type === Clutter.EventType.MOTION && this._progressScrubbing) {
                    this._seekFromEvent(playerTrack, ev);
                } else if (type === Clutter.EventType.BUTTON_RELEASE) {
                    endScrub();
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_STOP;
        });
        playerTrack.connect('button-release-event', () => {
            endScrub();
            return Clutter.EVENT_STOP;
        });

        this._playerElapsed = new St.Label({
            text: '0:00',
            style_class: 'brow-progress-time',
            x_align: Clutter.ActorAlign.START,
        });
        this._playerRemaining = new St.Label({
            text: '0:00',
            style_class: 'brow-progress-time',
            x_align: Clutter.ActorAlign.END,
        });
        const playerTimes = new St.BoxLayout({
            style_class: 'brow-progress-times-under',
            vertical: false,
            x_expand: true,
        });
        playerTimes.add_child(this._playerElapsed);
        playerTimes.add_child(new St.Widget({ x_expand: true }));
        playerTimes.add_child(this._playerRemaining);

        const playerProgress = new St.BoxLayout({
            style_class: 'brow-media-player-progress',
            vertical: true,
            x_expand: true,
        });
        playerProgress.add_child(playerTrack);
        playerProgress.add_child(playerTimes);

        const playerCenter = new St.BoxLayout({
            style_class: 'brow-media-buttons-center brow-media-buttons-center-player',
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._playerPrev = makeCtrlButton('media-skip-backward-symbolic', () => this.cmd('previous'), 36);
        this._playerPlay = makeCtrlButton('media-playback-start-symbolic', () => this.cmd('play-pause'), 42);
        this._playerNext = makeCtrlButton('media-skip-forward-symbolic', () => this.cmd('next'), 36);
        playerCenter.add_child(this._playerPrev);
        playerCenter.add_child(this._playerPlay);
        playerCenter.add_child(this._playerNext);

        volumeRow.visible = true;

        const player = new St.BoxLayout({
            style_class: 'brow-media-player-col',
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        player.add_child(artWrap);
        player.add_child(playerHead);
        player.add_child(playerProgress);
        player.add_child(playerCenter);
        player.add_child(volumeRow);
        player.add_child(pillWrap);
        this._playerColumn = player;

        tab.add_child(compact);
        tab.add_child(player);

        this._controlButtons = [
            this._btnPrev,
            this._btnPlay,
            this._btnNext,
            this._btnOutput,
            this._playerPrev,
            this._playerPlay,
            this._playerNext,
            this._btnOutputPill,
        ];
        this._progressTracks = [trackStack, playerTrack];
        return tab;
    }

    setPlayerMode(on) {
        const want = !!on;
        if (this._playerMode === want)
            return;
        this._playerMode = want;

        if (this._compactColumn)
            this._compactColumn.visible = !want;
        if (this._playerColumn)
            this._playerColumn.visible = want;
        this._host._syncPlayerChrome?.(want);
        if (this._mediaTabRoot)
            this._mediaTabRoot.y_align = want
                ? Clutter.ActorAlign.FILL
                : Clutter.ActorAlign.CENTER;

        if (!want)
            this._clearVolumeScrub();

        // Measure tracks after the shown column is allocated. Not an animation.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._updateProgressUi();
            if (this._playerMode)
                this.syncPlayerVolumeUi();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearVolumeScrub() {
        this._volumeScrubbing = false;
        if (this._volumeStageId) {
            try {
                global.stage.disconnect(this._volumeStageId);
            } catch (e) {
                // ignore
            }
            this._volumeStageId = 0;
        }
    }

    syncPlayerVolumeUi() {
        if (!this._volumeFill || !this._volumeTrackHit)
            return;
        const { level, muted } = this._host._readOutputVolume?.() || { level: 0, muted: true };
        let trackW = 0;
        try {
            trackW = this._volumeTrackHit.get_width?.() || 0;
        } catch (e) {
            trackW = 0;
        }
        if (!(trackW > 0))
            trackW = 200;
        const ratio = muted ? 0 : Math.max(0, Math.min(1, level));
        this._volumeFill.width = Math.max(0, Math.floor(trackW * ratio));
    }

    setControlsReactive(on) {
        (this._albumHits || []).forEach(stack => {
            if (stack)
                stack.reactive = !!on;
        });
        (this._controlButtons || []).forEach(btn => {
            if (!btn)
                return;
            btn.reactive = on;
            btn.can_focus = on;
        });
        (this._progressTracks || [this._progressTrackStack]).forEach(track => {
            if (!track)
                return;
            track.reactive = !!on;
        });
        if (!on) {
            this._progressScrubbing = false;
            if (this._progressStageId) {
                try {
                    global.stage.disconnect(this._progressStageId);
                } catch (e) {
                    // ignore
                }
                this._progressStageId = 0;
            }
        }
        if (this._volumeTrackHit) {
            this._volumeTrackHit.reactive = on && this._playerMode;
            if (!on)
                this._clearVolumeScrub();
        }
    }

    _ratioFromEvent(actor, event) {
        try {
            // get_coords() returns [x, y]
            const [x] = event.get_coords();
            const [ax] = actor.get_transformed_position();
            let aw = 0;
            try {
                aw = actor.get_transformed_size()[0];
            } catch (e) {
                aw = actor.width;
            }
            if (!(aw > 0))
                aw = actor.width || 1;
            return Math.max(0, Math.min(1, (x - ax) / aw));
        } catch (e) {
            return 0;
        }
    }

    _seekFromEvent(actor, event) {
        if (!(this._trackLengthSec > 0))
            return;
        this.seekToRatio(this._ratioFromEvent(actor, event));
    }

    seekToRatio(ratio) {
        if (!this._playerctlPath || !(this._trackLengthSec > 0))
            return;
        const sec = Math.max(0, Math.min(this._trackLengthSec, ratio * this._trackLengthSec));
        this._positionSec = sec;
        this._updateProgressUi();
        try {
            Gio.Subprocess.new(
                [this._playerctlPath, 'position', String(sec)],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            console.error('playerctl position seek failed:', e);
        }
    }

    cmd(cmd) {
        if (!this._playerctlPath)
            return;
        try {
            Gio.Subprocess.new([this._playerctlPath, cmd], Gio.SubprocessFlags.NONE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this.updateState();
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`playerctl ${cmd} failed:`, e);
        }
    }

    /** Create one spectrum view bound to the shared engine. Returns its actor. */
    _addSpectrum(maxHeight) {
        const view = createSpectrumView({ boxSize: WAVE_BOX_SIZE, maxHeight });
        if (this._waveColor)
            view.setColor(this._waveColor);
        view.actor.y_align = Clutter.ActorAlign.CENTER;
        view.actor.x_align = Clutter.ActorAlign.CENTER;
        this._spectrumViews.push(view);
        return view.actor;
    }

    /** rgb: { r, g, b } from the cover, or null for the default gradient. */
    _applyWaveColor(rgb) {
        this._waveColor = rgb;
        for (const view of this._spectrumViews)
            view.setColor(rgb);
    }

    _setArtFromFile(file) {
        const bg = fileToCssUrl(file);
        const style =
            `background-image: ${bg}; ` +
            'background-size: cover; background-repeat: no-repeat; ' +
            'background-position: center;';
        for (const cover of this._artCovers) {
            if (!cover)
                continue;
            cover.set_style(style);
            cover.visible = true;
        }
        if (this._albumPlaceholder)
            this._albumPlaceholder.visible = false;
        if (this._quickPlaceholder)
            this._quickPlaceholder.visible = false;

        const color = extractArtColor(file);
        this._applyWaveColor(color);
    }

    showPlaceholder() {
        for (const cover of this._artCovers) {
            if (!cover)
                continue;
            cover.set_style('');
            cover.visible = false;
        }
        if (this._albumPlaceholder)
            this._albumPlaceholder.visible = true;
        if (this._quickPlaceholder)
            this._quickPlaceholder.visible = true;
        this._artUrl = null;
        this._applyWaveColor(null);
    }

    setAlbumArt(url) {
        if (!url) {
            this.showPlaceholder();
            return;
        }
        if (url === this._artUrl && this._albumCover?.visible)
            return;
        this._artUrl = url;

        try {
            if (url.startsWith('file://') || url.startsWith('/')) {
                const file = url.startsWith('/')
                    ? Gio.File.new_for_path(url)
                    : Gio.File.new_for_uri(url);
                this._setArtFromFile(file);
                return;
            }

            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                this.showPlaceholder();
                return;
            }
            this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                if (!this._host._island)
                    return;
                try {
                    if (msg.get_status() !== Soup.Status.OK) {
                        this.showPlaceholder();
                        return;
                    }
                    const bytes = session.send_and_read_finish(res);
                    const data = bytes.get_data();
                    const tmp = GLib.build_filenamev([
                        GLib.get_tmp_dir(),
                        `brow-art-${GLib.get_monotonic_time()}.img`,
                    ]);
                    const file = Gio.File.new_for_path(tmp);
                    file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    if (this._artTmpPath && this._artTmpPath !== tmp) {
                        try {
                            Gio.File.new_for_path(this._artTmpPath).delete(null);
                        } catch (e2) {
                            // ignore
                        }
                    }
                    this._artTmpPath = tmp;
                    this._setArtFromFile(file);
                } catch (e) {
                    this.showPlaceholder();
                }
            });
        } catch (e) {
            this.showPlaceholder();
        }
    }

    _tickWave() {
        const playing = !!this._host._isPlaying;
        const now = GLib.get_monotonic_time() / 1000;
        const dt = this._lastWaveTickMs ? Math.min(100, now - this._lastWaveTickMs) : WAVE_TICK_MS;
        this._lastWaveTickMs = now;

        const levels = this._spectrum.step(playing, dt);
        for (const view of this._spectrumViews)
            view.render(levels);
    }

    _startWaveAnimation() {
        if (this._waveSource)
            return;
        this._tickWave();
        this._waveSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, WAVE_TICK_MS, () => {
            try {
                if (!this._host._island) {
                    this._waveSource = null;
                    return GLib.SOURCE_REMOVE;
                }
                this._tickWave();
                if (!this._host._isPlaying) {
                    if (this._spectrum.isSettled()) {
                        this._waveSource = null;
                        return GLib.SOURCE_REMOVE;
                    }
                }
                return GLib.SOURCE_CONTINUE;
            } catch (e) {
                console.error('Brow wave tick failed:', e);
                this._waveSource = null;
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    _stopWaveAnimation() {
        if (!this._host._isPlaying && !this._waveSource)
            this._startWaveAnimation();
    }

    _forceStopWave() {
        this._spectrum?.stopAudio();
        this._lastWaveTickMs = 0;
        if (this._waveSource) {
            GLib.source_remove(this._waveSource);
            this._waveSource = null;
        }
    }

    _syncWaveAnimation() {
        // Always ensure a live timer while playing (restart if a prior tick aborted)
        if (this._host._isPlaying) {
            if (!this._waveSource)
                this._startWaveAnimation();
        } else {
            this._stopWaveAnimation();
        }
    }

    _setProgressPair(elapsed, remaining, fill, track) {
        const len = this._trackLengthSec;
        const pos = Math.min(this._positionSec, len || this._positionSec);
        elapsed?.set_text(formatClock(pos));
        if (len > 0) {
            remaining?.set_text(`-${formatClock(Math.max(0, len - pos))}`);
            let trackW = 0;
            try {
                trackW = track?.get_width?.() || 0;
            } catch (e) {
                trackW = 0;
            }
            if (fill && trackW > 0)
                fill.width = Math.max(0, Math.floor(trackW * (pos / len)));
        } else {
            remaining?.set_text('0:00');
            if (fill)
                fill.width = 0;
        }
    }

    _updateProgressUi() {
        this._setProgressPair(
            this._elapsedLabel,
            this._remainingLabel,
            this._progressFill,
            this._progressTrackStack,
        );
        this._setProgressPair(
            this._playerElapsed,
            this._playerRemaining,
            this._playerProgressFill,
            this._playerProgressTrack,
        );
    }

    _setTitles(title, artist) {
        this._cardTitle?.set_text(title);
        this._cardArtist?.set_text(artist);
        this._playerTitle?.set_text(title);
        this._playerArtist?.set_text(artist);
    }

    _setPlayIcon(playing) {
        const name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        for (const btn of [this._btnPlay, this._playerPlay]) {
            if (btn?._browIcon)
                btn._browIcon.icon_name = name;
        }
    }

    _pollPosition() {
        if (!this._playerctlPath || !this._host._island)
            return;
        try {
            const proc = Gio.Subprocess.new(
                [this._playerctlPath, 'position'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [ok, out] = p.communicate_utf8_finish(res);
                    if (ok && out) {
                        const v = parseFloat(out.trim());
                        if (Number.isFinite(v) && !this._progressScrubbing)
                            this._positionSec = v;
                    }
                } catch (e) {
                    // ignore
                }
                if (!this._progressScrubbing)
                    this._updateProgressUi();
            });
        } catch (e) {
            // ignore
        }
    }

    startProgressPolling() {
        this.stopProgressPolling();
        this._pollPosition();
        this._progressSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_POLL_MS, () => {
            if (!this._host._island)
                return GLib.SOURCE_REMOVE;
            if (this._host._isExpanded && this._host._currentTab === 1)
                this._pollPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopProgressPolling() {
        if (this._progressSource) {
            GLib.source_remove(this._progressSource);
            this._progressSource = null;
        }
    }

    startMetaPolling() {
        this.updateState();
        this._metaSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this.updateState();
            return GLib.SOURCE_CONTINUE;
        });
        this.startProgressPolling();
    }

    stopMetaPolling() {
        if (this._metaSource) {
            GLib.source_remove(this._metaSource);
            this._metaSource = null;
        }
        this.stopProgressPolling();
        this._forceStopWave();
    }

    updateState() {
        const host = this._host;
        if (!host._island || this._busy)
            return;

        if (!this._playerctlPath) {
            this._playerctlPath = findPlayerctl();
            if (!this._playerctlPath)
                return;
        }

        try {
            this._busy = true;
            const proc = Gio.Subprocess.new(
                [
                    this._playerctlPath,
                    'metadata',
                    '--format',
                    '{{mpris:artUrl}}||{{title}}||{{artist}}||{{status}}||{{mpris:length}}',
                ],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (p, res) => {
                this._busy = false;
                if (!host._island)
                    return;

                try {
                    const [success, stdout] = p.communicate_utf8_finish(res);
                    if (success && stdout) {
                        const parts = stdout.trim().split('||');
                        if (parts.length >= 4) {
                            const artUrl = parts[0] || '';
                            const title = parts[1] || 'unknown';
                            const artist = parts[2] || 'unknown';
                            const status = (parts[3] || '').toLowerCase();
                            const lengthUs = parseInt(parts[4] || '0', 10);

                            host._isPlaying = status === 'playing';
                            host._onPlaybackChanged?.();
                            this._setTitles(title, artist);

                            if (Number.isFinite(lengthUs) && lengthUs > 0)
                                this._trackLengthSec = lengthUs / 1e6;
                            else
                                this._trackLengthSec = 0;

                            this._setPlayIcon(host._isPlaying);
                            this.setAlbumArt(artUrl);
                            this._updateProgressUi();
                            this._syncWaveAnimation();
                            host._updateIslandView();
                            return;
                        }
                    }
                } catch (e) {
                    // no player
                }

                this.showPlaceholder();
                this._setTitles('not playing', '—');
                this._trackLengthSec = 0;
                this._positionSec = 0;
                this._updateProgressUi();
                this._setPlayIcon(false);
                if (host._isPlaying) {
                    host._isPlaying = false;
                    host._onPlaybackChanged?.();
                    this._syncWaveAnimation();
                    host._updateIslandView();
                } else {
                    this._syncWaveAnimation();
                }
            });
        } catch (e) {
            this._busy = false;
            console.error('Failed to launch playerctl:', e);
            this.showPlaceholder();
            if (host._isPlaying && host._island) {
                host._isPlaying = false;
                host._onPlaybackChanged?.();
                this._syncWaveAnimation();
                host._updateIslandView();
            }
        }
    }

    destroy() {
        this._progressScrubbing = false;
        if (this._progressStageId) {
            try {
                global.stage.disconnect(this._progressStageId);
            } catch (e) {
                // ignore
            }
            this._progressStageId = 0;
        }
        this._clearVolumeScrub();
        if (this._playerMode)
            this.setPlayerMode(false);
        this.stopMetaPolling();
        this._spectrum?.destroy();
        this._spectrum = null;
        this._spectrumViews = [];
        if (this._artTmpPath) {
            try {
                Gio.File.new_for_path(this._artTmpPath).delete(null);
            } catch (e) {
                // ignore
            }
            this._artTmpPath = null;
        }
    }
}
