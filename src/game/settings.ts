// ============================================================
// Game Settings — defaults + localStorage persistence
// Single source of truth for all configurable options.
// ============================================================

const STORAGE_KEY = 'tsdoom_settings';

/** All settings with their default values */
interface Settings {
  resolutionIndex: number;
  mouseSensitivity: number;  // 0-9
  trueColor: boolean;
  dynLights: boolean;
  ssao: boolean;
  sfxVolume: number;    // 0-10 (0%=0, 10%=1, ..., 100%=10)
  musicVolume: number;  // 0-10
}

const DEFAULTS: Readonly<Settings> = {
  resolutionIndex: 3,     // 1280x800
  mouseSensitivity: 3,    // moderate
  trueColor: false,       // classic palette mode
  dynLights: true,        // dynamic lights enabled by default
  ssao: true,             // ambient occlusion enabled by default
  sfxVolume: 8,           // 80%
  musicVolume: 8,         // 80%
};

/** Current settings (initialized from defaults, overridden by localStorage) */
let current: Settings = { ...DEFAULTS };

/** Load settings from localStorage (call once at startup) */
export function loadSettings(): void {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return;
    const saved = JSON.parse(json);
    if (typeof saved.resolutionIndex === 'number') {
      current.resolutionIndex = saved.resolutionIndex;
    }
    if (typeof saved.mouseSensitivity === 'number') {
      current.mouseSensitivity = Math.max(0, Math.min(9, saved.mouseSensitivity));
    }
    if (typeof saved.trueColor === 'boolean') {
      current.trueColor = saved.trueColor;
    }
    if (typeof saved.dynLights === 'boolean') {
      current.dynLights = saved.dynLights;
    }
    if (typeof saved.ssao === 'boolean') {
      current.ssao = saved.ssao;
    }
    if (typeof saved.sfxVolume === 'number') {
      current.sfxVolume = Math.max(0, Math.min(10, saved.sfxVolume));
    }
    if (typeof saved.musicVolume === 'number') {
      current.musicVolume = Math.max(0, Math.min(10, saved.musicVolume));
    }
  } catch { /* ignore */ }
}

/** Persist current settings to localStorage */
function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch { /* ignore quota errors */ }
}

// ── Getters ──

export function getResolutionIndex(): number { return current.resolutionIndex; }
export function getMouseSensitivityLevel(): number { return current.mouseSensitivity; }
export function getTrueColor(): boolean { return current.trueColor; }
export function getDynLights(): boolean { return current.dynLights; }
export function getSsao(): boolean { return current.ssao; }
export function getSfxVolume(): number { return current.sfxVolume; }
export function getMusicVolume(): number { return current.musicVolume; }

// ── Setters (auto-persist) ──

export function setResolutionIndex(idx: number): void {
  current.resolutionIndex = idx;
  save();
}

export function setMouseSensitivityLevel(level: number): void {
  current.mouseSensitivity = Math.max(0, Math.min(9, level));
  save();
}

export function setTrueColor(enabled: boolean): void {
  current.trueColor = enabled;
  save();
}

export function setDynLights(enabled: boolean): void {
  current.dynLights = enabled;
  save();
}

export function setSsao(enabled: boolean): void {
  current.ssao = enabled;
  save();
}

export function setSfxVolume(vol: number): void {
  current.sfxVolume = Math.max(0, Math.min(10, vol));
  save();
}

export function setMusicVolume(vol: number): void {
  current.musicVolume = Math.max(0, Math.min(10, vol));
  save();
}
