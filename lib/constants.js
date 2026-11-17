export const HOVER_LEAVE_DELAY_MS = 200;
export const HIT_PAD_X = 24;
export const HIT_PAD_BOTTOM = 14;
export const TOP_MARGIN_MIN = 0;
export const TOP_MARGIN_MAX = 40;
export const TAB_COUNT = 6;
export const SHORTCUT_COUNT = 4;
export const SHORTCUT_LONG_PRESS_MS = 500;
export const WEATHER_INTERVAL_SEC = 30 * 60;
export const ALBUM_SIZE = 48;
export const QUICK_ART_SIZE = 28;
export const PROGRESS_POLL_MS = 1000;
export const WAVE_TICK_MS = 33;
/** Compact square spectrum box. */
export const WAVE_BOX_SIZE = 32;
export const WAVE_H_MAX = 28;
export const WAVE_H_MAX_CARD = 28;
/** Shared expanded peninsula height (all tabs). */
export const EXPANDED_HEIGHT = 220;
export const MEDIA_COMPACT_WIDTH = 265;
export const MEDIA_HOVER_WIDTH = 300;
/** Tall “large player” morph (album-art expand). */
export const MEDIA_PLAYER_WIDTH = 340;
export const MEDIA_PLAYER_HEIGHT = 560;
export const MEDIA_PLAYER_ART_SIZE = 200;
export const BATTERY_BANNER_MS = 3000;
export const BATTERY_BANNER_WIDTH = 300;
export const BATTERY_BANNER_HEIGHT = 40;
export const VOLUME_HUD_MS = 2500;
export const VOLUME_HUD_WIDTH = BATTERY_BANNER_WIDTH;
export const VOLUME_HUD_HEIGHT = BATTERY_BANNER_HEIGHT;
export const LOW_BATTERY_PCT = 20;
export const NOTICE_HUD_MS = 4500;
export const NOTICE_HUD_WIDTH = 340;
export const NOTICE_HUD_HEIGHT = 48;

/**
 * Motion tokens. One place for every island animation timing.
 * MORPH: width/height of the island. FADE: content cross-fades.
 * FADE_FAST: quick/media strips. TAB: page slide between tabs.
 */
export const MOTION = {
    MORPH_MS: 350,
    FADE_MS: 200,
    FADE_FAST_MS: 150,
    TAB_MS: 250,
};
