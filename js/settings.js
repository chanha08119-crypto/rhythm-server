export const settings = {
    KEYS: ['d', 'f', 'j'],
    GAME_SPEED: 1.5,
    GLOBAL_OFFSET: 0,
};

export function applySettingsToWindow() {
    window.KEYS = settings.KEYS;
    window.GAME_SPEED = settings.GAME_SPEED;
    window.GLOBAL_OFFSET = settings.GLOBAL_OFFSET;
}
