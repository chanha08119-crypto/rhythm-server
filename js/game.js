import { settings, applySettingsToWindow } from './settings.js';
import { initAuth } from './auth.js';

const APP_MODE = window.APP_MODE === 'editor' ? 'editor' : 'play';

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

applySettingsToWindow();

let bindingIndex = -1;

const LANE_WIDTH = 100;
const LANE_COUNT = APP_MODE === 'play' ? 4 : 3;
const TOTAL_WIDTH = LANE_WIDTH * LANE_COUNT;
const NOTE_HEIGHT = 20;
const SAME_LANE_MIN_GAP_MS = 60;
let JUDGE_Y = 0;

let gameState = 'MENU';
let audioStartTime = 0;
let tonePlayer = null;
let beepSynth = null;
let youtubePlayer = null;
let youtubeVideoId = null;
let youtubeIsPlaying = false;
let youtubeApiPromise = null;
let youtubeLastErrorCode = null;

let stats = { score: 0, combo: 0, maxCombo: 0, perfect: 0, great: 0, good: 0, miss: 0 };
const keyState = Array(LANE_COUNT).fill(false);
const keyPressTimes = Array(LANE_COUNT).fill(0);
let visualEffects = [];
let offsetCalibration = null;
let calibrationAnimationFrame = null;

class Note {
    constructor(data) {
        this.time = data.time;
        this.lane = data.lane;
        this.type = data.type || 'short';
        this.duration = data.duration || 0;
        this.isHit = false;
        this.isMissed = false;
        this.isHolding = false;
    }
}

function createMockNotes(bpm, count) {
    const notes = [];
    const interval = (60 / bpm) * 1000;
    for (let i = 0; i < count; i++) {
        let lane = Math.floor(Math.random() * LANE_COUNT);
        if (i % 4 === 0) lane = 1;
        notes.push({ time: 2000 + (i * interval), lane: lane, type: 'short' });
    }
    return notes;
}

function getLaneKeys() {
    return settings.KEYS.slice(0, LANE_COUNT);
}

function ensurePlayKeys() {
    if (APP_MODE !== 'play') return;
    const defaults = ['d', 'f', 'j', 'k'];
    settings.KEYS = defaults.map((fallback, index) => settings.KEYS[index] || fallback);
    applySettingsToWindow();
}

// 맵 파일의 타이밍은 유지하고, 플레이할 때만 4개 레인에 새로 배치한다.
// 같은 레인에 180ms 안쪽으로 노트가 겹치면 다른 레인을 우선 사용한다.
function createFourKeyPlayNotes(sourceNotes) {
    const lastTimeByLane = Array(4).fill(-Infinity);
    const orderedNotes = sourceNotes
        .filter(note => Number.isFinite(Number(note.time)))
        .map(note => ({ ...note, time: Number(note.time) }))
        .sort((a, b) => a.time - b.time);

    return orderedNotes.map(note => {
        let playTime = note.time;
        let availableLanes = [0, 1, 2, 3].filter(lane => playTime - lastTimeByLane[lane] >= SAME_LANE_MIN_GAP_MS);
        if (availableLanes.length === 0) {
            // 동시에 5개 이상이 몰린 경우에도 같은 레인 간격을 지키도록,
            // 가장 빨리 비는 레인까지 해당 노트만 지연한다.
            playTime = Math.min(...lastTimeByLane.map(lastTime => lastTime + SAME_LANE_MIN_GAP_MS));
            availableLanes = [0, 1, 2, 3].filter(lane => playTime - lastTimeByLane[lane] >= SAME_LANE_MIN_GAP_MS);
        }
        const lane = availableLanes[Math.floor(Math.random() * availableLanes.length)];
        lastTimeByLane[lane] = playTime;
        return { ...note, time: playTime, lane };
    });
}

const builtInMaps = [
    { id: 'map1', title: '튜토리얼 곡 (130BPM)', difficulty: 2, uploaded: true, notes: createMockNotes(130, 20), audioUrl: null, creator: 'System' },
    { id: 'map2', title: '빠른 곡 (180BPM)', difficulty: 5, uploaded: true, notes: createMockNotes(180, 50), audioUrl: null, creator: 'System' }
];

function createCustomMap() {
    return { id: 'map_custom', title: '나만의 커스텀 맵', difficulty: 5, uploaded: false, notes: [], audioUrl: null, youtubeUrl: null, creator: '나' };
}

let beatmapList = APP_MODE === 'play' ? [...builtInMaps] : [createCustomMap()];

function isOwnMap(map) {
    if (!map) return false;
    if (map.id === 'map_custom' || !map.uploaded) return true;
    const userObj = window.currentUser;
    if (!userObj) return false;
    if (map.creator_unique_id && userObj.uniqueId) {
        return userObj.uniqueId === map.creator_unique_id;
    }
    if (userObj.uid && map.user_id) {
        return userObj.uid === map.user_id;
    }
    return false;
}

window.updateServerMaps = (serverMaps) => {
    const mergedServerMaps = serverMaps.map(serverMap => {
        const existing = beatmapList.find(m => m.id === serverMap.id);
        if (existing && existing.localAudioUrl) {
            serverMap.localAudioUrl = existing.localAudioUrl;
            serverMap.file = existing.file;
        }
        return serverMap;
    });

    if (APP_MODE === 'play') {
        const playable = mergedServerMaps.filter(m => Array.isArray(m.notes) && m.notes.length > 0);
        beatmapList = [...builtInMaps, ...playable];
    } else {
        const existingCustom = beatmapList.find(m => m.id === 'map_custom') || createCustomMap();
        const ownMaps = mergedServerMaps.filter(isOwnMap);
        beatmapList = [...ownMaps, existingCustom];
    }

    if (currentMapIndex >= beatmapList.length) currentMapIndex = 0;

    const songSelect = document.getElementById('song-select-ui');
    if (songSelect && !songSelect.classList.contains('hidden')) {
        renderSongList();
    }
};

let currentMapIndex = 0;
let activeNotes = [];
let recordedNotes = [];

function showToast(msg, isError = false) {
    const toast = document.getElementById('toast-msg');
    toast.innerText = msg;
    toast.className = `absolute top-10 left-1/2 transform -translate-x-1/2 px-8 py-4 rounded-full shadow-2xl z-50 transition-all duration-300 font-bold text-lg ${isError ? 'bg-red-600' : 'bg-blue-600'} text-white`;
    toast.style.opacity = 1;
    toast.style.transform = 'translate(-50%, 0)';
    setTimeout(() => {
        toast.style.opacity = 0;
        toast.style.transform = 'translate(-50%, -20px)';
    }, 3000);
}
window.showToast = showToast;

function showUI(uiId) {
    ['menu-ui', 'settings-ui', 'song-select-ui', 'game-ui', 'result-ui', 'upload-ui', 'offset-calibration-ui'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const target = document.getElementById(uiId);
    if (target) target.classList.remove('hidden');
    if (uiId === 'song-select-ui') renderSongList();
}
window.showUI = showUI;

function startKeyBind(index) {
    bindingIndex = index;
    document.getElementById('keybind-msg').style.opacity = 1;
    document.getElementById(`key-btn-${index}`).innerText = '?';
    document.getElementById(`key-btn-${index}`).classList.add('animate-pulse', 'bg-blue-600');
}
window.startKeyBind = startKeyBind;

function updateSettingsUI() {
    try {
        ensurePlayKeys();
        for (let i = 0; i < LANE_COUNT; i++) {
            const btn = document.getElementById(`key-btn-${i}`);
            if (btn) btn.innerText = settings.KEYS[i].toUpperCase();
        }

        const speedSlider = document.getElementById('speed-slider');
        const speedVal = document.getElementById('speed-val');
        if (speedSlider && speedVal) {
            speedSlider.value = settings.GAME_SPEED;
            speedVal.innerText = settings.GAME_SPEED.toFixed(1) + 'x';
        }

        const offsetSlider = document.getElementById('offset-slider');
        const offsetVal = document.getElementById('offset-val');
        if (offsetSlider && offsetVal) {
            offsetSlider.value = settings.GLOBAL_OFFSET;
            offsetVal.innerText = settings.GLOBAL_OFFSET + 'ms';
        }
    } catch (e) {
        console.warn('설정 UI 업데이트 오류:', e.message);
    }
}
window.updateSettingsUI = updateSettingsUI;

window.addEventListener('keydown', (e) => {
    if (bindingIndex !== -1) {
        const key = e.key.toLowerCase();
        settings.KEYS[bindingIndex] = key;
        applySettingsToWindow();
        const btn = document.getElementById(`key-btn-${bindingIndex}`);
        btn.innerText = key.toUpperCase();
        btn.classList.remove('animate-pulse', 'bg-blue-600');
        bindingIndex = -1;
        document.getElementById('keybind-msg').style.opacity = 0;
        window.scheduleSettingsSave();
        return;
    }

    if (gameState === 'PLAYING' || gameState === 'RECORDING') {
        const key = e.key.toLowerCase();
        const idx = getLaneKeys().indexOf(key);
        if (idx !== -1 && !keyState[idx]) processInput(idx);
    }
});

window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    const idx = getLaneKeys().indexOf(key);
    if (idx !== -1) releaseInput(idx);
});

const speedSlider = document.getElementById('speed-slider');
if (speedSlider) {
    speedSlider.addEventListener('input', (e) => {
        settings.GAME_SPEED = parseFloat(e.target.value);
        applySettingsToWindow();
        document.getElementById('speed-val').innerText = settings.GAME_SPEED.toFixed(1) + 'x';
        window.scheduleSettingsSave();
    });
}
const offsetSlider = document.getElementById('offset-slider');
if (offsetSlider) {
    offsetSlider.addEventListener('input', (e) => {
        settings.GLOBAL_OFFSET = parseInt(e.target.value);
        applySettingsToWindow();
        document.getElementById('offset-val').innerText = settings.GLOBAL_OFFSET + 'ms';
        window.scheduleSettingsSave();
    });
}

function updateCalibrationUI() {
    if (!offsetCalibration) return;
    const countEl = document.getElementById('calibration-count');
    const signalEl = document.getElementById('calibration-signal');
    if (countEl) countEl.innerText = `${offsetCalibration.offsets.length} / 8`;

    const elapsed = (Tone.now() * 1000) - offsetCalibration.startTime;
    const pulse = elapsed >= 0 && (elapsed % offsetCalibration.beatDuration) < 100;
    if (signalEl) {
        signalEl.className = `w-28 h-28 rounded-full mx-auto transition-all duration-75 ${pulse ? 'bg-purple-400 scale-110 shadow-[0_0_45px_15px_rgba(192,132,252,0.7)]' : 'bg-gray-700 scale-100'}`;
    }
    calibrationAnimationFrame = requestAnimationFrame(updateCalibrationUI);
}

function calculateCalibratedOffset(offsets) {
    // 첫 두 번은 박자에 적응하는 구간으로 제외하고, 중앙값에서 크게 벗어난 탭은 무시한다.
    const samples = offsets.slice(2);
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const reliable = samples.filter(offset => Math.abs(offset - median) <= 100);
    return Math.round(reliable.reduce((sum, offset) => sum + offset, 0) / reliable.length);
}

function finishOffsetCalibration() {
    if (!offsetCalibration) return;
    const calibratedOffset = Math.max(-200, Math.min(200, calculateCalibratedOffset(offsetCalibration.offsets)));
    settings.GLOBAL_OFFSET = calibratedOffset;
    applySettingsToWindow();
    updateSettingsUI();
    window.scheduleSettingsSave();

    const resultEl = document.getElementById('calibration-result');
    const tapButton = document.getElementById('calibration-tap-button');
    if (resultEl) resultEl.innerText = `보정 완료: ${calibratedOffset > 0 ? '+' : ''}${calibratedOffset}ms`;
    if (tapButton) tapButton.disabled = true;
    Tone.Transport.stop();
    Tone.Transport.cancel();
    offsetCalibration = null;
    if (calibrationAnimationFrame) cancelAnimationFrame(calibrationAnimationFrame);
}

function tapCalibrationBeat() {
    if (!offsetCalibration) return;
    const elapsed = (Tone.now() * 1000) - offsetCalibration.startTime;
    if (elapsed < 0) return;
    const nearestBeat = Math.round(elapsed / offsetCalibration.beatDuration) * offsetCalibration.beatDuration;
    const difference = elapsed - nearestBeat;
    if (Math.abs(difference) > 250) return showToast('다음 박자에 맞춰 다시 탭해 주세요.', true);

    offsetCalibration.offsets.push(difference);
    const feedback = document.getElementById('calibration-feedback');
    if (feedback) feedback.innerText = `${difference > 0 ? '+' : ''}${Math.round(difference)}ms`;
    if (offsetCalibration.offsets.length >= 8) finishOffsetCalibration();
}

async function openOffsetCalibration() {
    if (gameState === 'PLAYING' || gameState === 'RECORDING') return;
    document.getElementById('offset-calibration-ui')?.classList.remove('hidden');
    const resultEl = document.getElementById('calibration-result');
    const tapButton = document.getElementById('calibration-tap-button');
    if (resultEl) resultEl.innerText = '시작을 누른 뒤, 빛과 소리에 맞춰 8번 탭하세요.';
    if (tapButton) tapButton.disabled = false;
}

async function startOffsetCalibration() {
    try {
        await Tone.start();
        if (!beepSynth) beepSynth = new Tone.PolySynth(Tone.Synth).toDestination();
        Tone.Transport.stop();
        Tone.Transport.cancel();
        Tone.Transport.position = 0;
        Tone.Transport.bpm.value = 120;
        offsetCalibration = { startTime: (Tone.now() * 1000) + 1000, beatDuration: 500, offsets: [] };
        Tone.Transport.scheduleRepeat(time => beepSynth.triggerAttackRelease('C6', '32n', time), '4n', 0);
        Tone.Transport.start('+1');
        updateCalibrationUI();
    } catch (error) {
        showToast('오디오 보정을 시작할 수 없습니다.', true);
    }
}

function closeOffsetCalibration() {
    if (calibrationAnimationFrame) cancelAnimationFrame(calibrationAnimationFrame);
    calibrationAnimationFrame = null;
    offsetCalibration = null;
    Tone.Transport.stop();
    Tone.Transport.cancel();
    document.getElementById('offset-calibration-ui')?.classList.add('hidden');
}

window.openOffsetCalibration = openOffsetCalibration;
window.startOffsetCalibration = startOffsetCalibration;
window.tapCalibrationBeat = tapCalibrationBeat;
window.closeOffsetCalibration = closeOffsetCalibration;

window.addEventListener('keydown', event => {
    if (!offsetCalibration) return;
    if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault();
        tapCalibrationBeat();
    }
});

function renderSongList() {
    const listEl = document.getElementById('song-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    beatmapList.forEach((map, idx) => {
        const isSelected = (idx === currentMapIndex);
        const bgClass = isSelected ? 'bg-blue-900 border-blue-500' : 'bg-gray-800 border-gray-700 hover:bg-gray-750';
        const diffColor = (map.difficulty || 5) <= 3 ? '🟢' : (map.difficulty || 5) <= 6 ? '🟡' : '🔴';

        const btn = document.createElement('div');
        btn.className = `p-4 rounded-xl border cursor-pointer transition-colors ${bgClass}`;
        btn.innerHTML = `
            <div class="flex justify-between items-start">
                <h4 class="font-bold text-lg text-white">${map.title}</h4>
                <span class="text-xs font-bold text-gray-300">${diffColor} ${map.difficulty || 5}</span>
            </div>
        `;
        btn.onclick = () => selectMap(idx);
        listEl.appendChild(btn);
    });
    updateMapInfo();
}

function selectMap(idx) {
    currentMapIndex = idx;
    renderSongList();
}

function updateMapInfo() {
    const map = beatmapList[currentMapIndex];
    if (!map) return;

    const titleEl = document.getElementById('info-title');
    if (titleEl) titleEl.innerText = map.title;
    if (document.getElementById('info-difficulty')) {
        document.getElementById('info-difficulty').innerText = map.difficulty || 5;
    }
    if (document.getElementById('info-notes')) {
        document.getElementById('info-notes').innerText = map.notes.length;
    }
    if (document.getElementById('info-upload')) {
        document.getElementById('info-upload').innerText = map.uploaded ? '서버에 저장됨' : '로컬 기기 (미등록)';
        document.getElementById('info-upload').className = map.uploaded ? 'text-green-400 font-bold' : 'text-yellow-400 font-bold';
    }
    if (document.getElementById('info-creator')) {
        document.getElementById('info-creator').innerText = map.creator || (map.user_id ? `User(${map.user_id.slice(0, 5)})` : '익명/System');
    }

    const youtubeInput = document.getElementById('youtube-url');
    const youtubeStatus = document.getElementById('youtube-status');
    if (youtubeInput) youtubeInput.value = map.youtubeUrl || '';
    if (youtubeStatus) {
        youtubeStatus.innerText = map.youtubeUrl ? '유튜브 배경 영상이 설정되었습니다.' : '선택 사항 · 링크나 퍼가기 코드를 넣을 수 있습니다.';
        youtubeStatus.className = `text-xs mt-1 ${map.youtubeUrl ? 'text-red-300' : 'text-gray-500'}`;
    }

    const statusEl = document.getElementById('upload-status');
    if (statusEl) {
        if (map.audioUrl || map.localAudioUrl) {
            statusEl.innerText = '오디오 재생 준비됨';
            statusEl.classList.remove('hidden');
            statusEl.classList.replace('text-yellow-400', 'text-green-400');
        } else {
            statusEl.innerText = '오디오 없음 (비프음 대체)';
            statusEl.classList.remove('hidden');
            statusEl.classList.replace('text-green-400', 'text-yellow-400');
        }
    }

    const ownerControls = document.getElementById('owner-controls');
    if (ownerControls) {
        const isOwner = map.uploaded && isOwnMap(map) && window.currentUser && window.currentUser.uniqueId;
        if (isOwner) ownerControls.classList.remove('hidden');
        else ownerControls.classList.add('hidden');
    }

    const playtestBtn = document.getElementById('btn-playtest');
    if (playtestBtn) {
        playtestBtn.classList.toggle('hidden', !isOwnMap(map));
    }
}
window.updateMapInfo = updateMapInfo;

function getYoutubeVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        // YouTube의 "퍼가기" 메뉴에서 복사한 iframe 코드도 그대로 받을 수 있다.
        const sourceMatch = url.match(/<iframe[^>]+\bsrc\s*=\s*["']([^"']+)["']/i);
        const source = (sourceMatch ? sourceMatch[1] : url).trim();
        const parsed = new URL(source);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        let id = null;
        if (host === 'youtu.be') id = parsed.pathname.split('/').filter(Boolean)[0];
        else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
            id = parsed.searchParams.get('v') || parsed.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1];
        }
        return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
    } catch (error) {
        return null;
    }
}

function saveYoutubeUrl() {
    const map = beatmapList[currentMapIndex];
    const input = document.getElementById('youtube-url');
    if (!map || !input) return;
    const url = input.value.trim();
    if (url && !getYoutubeVideoId(url)) return showToast('유효한 YouTube 링크를 입력해주세요.', true);

    map.youtubeUrl = url || null;
    if (map.uploaded && map.id && window.updateMapInServer) {
        window.updateMapInServer(map.id, { title: map.title, difficulty: map.difficulty, youtubeUrl: map.youtubeUrl });
    }
    updateMapInfo();
    showToast(url ? '유튜브 배경 영상이 적용되었습니다.' : '유튜브 배경 영상을 제거했습니다.');
}
window.saveYoutubeUrl = saveYoutubeUrl;

async function deleteCurrentMap() {
    const map = beatmapList[currentMapIndex];
    if (!map || !map.uploaded) return;
    if (!isOwnMap(map)) return showToast('본인이 작성한 맵만 삭제할 수 있습니다.', true);

    showToast('맵 삭제 중...');
    const success = await window.deleteMapFromServer(map.id);
    if (success) {
        showToast(`${map.title} 맵이 성공적으로 삭제되었습니다.`);
        beatmapList.splice(currentMapIndex, 1);
        currentMapIndex = Math.max(0, currentMapIndex - 1);
        renderSongList();
    }
}
window.deleteCurrentMap = deleteCurrentMap;

function openEditMapModal() {
    const map = beatmapList[currentMapIndex];
    if (!isOwnMap(map)) return showToast('본인이 작성한 맵만 수정할 수 있습니다.', true);
    document.getElementById('edit-title').value = map.title;
    const diff = map.difficulty || 5;
    document.getElementById('edit-difficulty').value = diff;
    document.getElementById('edit-difficulty-display').innerText = diff;
    document.getElementById('edit-youtube-url').value = map.youtubeUrl || '';
    document.getElementById('edit-map-modal').classList.remove('hidden');
}
window.openEditMapModal = openEditMapModal;

function closeEditMapModal() {
    const modal = document.getElementById('edit-map-modal');
    if (modal) modal.classList.add('hidden');
}
window.closeEditMapModal = closeEditMapModal;

async function saveEditMap() {
    const map = beatmapList[currentMapIndex];
    const newTitle = document.getElementById('edit-title').value.trim();
    const newDifficulty = parseInt(document.getElementById('edit-difficulty').value) || 5;
    const newYoutubeUrl = document.getElementById('edit-youtube-url').value.trim();

    if (!newTitle) return showToast('곡 제목을 입력해주세요.', true);
    if (newYoutubeUrl && !getYoutubeVideoId(newYoutubeUrl)) return showToast('유효한 YouTube 링크를 입력해주세요.', true);

    map.title = newTitle;
    map.difficulty = newDifficulty;
    map.youtubeUrl = newYoutubeUrl || null;

    if (map.uploaded && map.id) {
        await window.updateMapInServer(map.id, { title: newTitle, difficulty: newDifficulty, youtubeUrl: map.youtubeUrl });
    }

    closeEditMapModal();
    renderSongList();
    showToast('맵 정보가 업데이트 되었습니다.');
}
window.saveEditMap = saveEditMap;

function initUploadModal() {
    const difficultySlider = document.getElementById('upload-difficulty');
    if (!difficultySlider || difficultySlider.dataset.bound) return;
    difficultySlider.dataset.bound = '1';
    difficultySlider.addEventListener('input', (e) => {
        document.getElementById('difficulty-display').innerText = e.target.value;
    });
}

function openUploadInfoModal() {
    document.getElementById('upload-info-modal').classList.remove('hidden');
    const map = beatmapList[currentMapIndex];
    document.getElementById('upload-title').value = map.title || '';
    document.getElementById('upload-difficulty').value = 5;
    document.getElementById('difficulty-display').innerText = '5';
    document.getElementById('upload-title').focus();
}
window.openUploadInfoModal = openUploadInfoModal;

function closeUploadInfoModal() {
    const modal = document.getElementById('upload-info-modal');
    if (modal) modal.classList.add('hidden');
}
window.closeUploadInfoModal = closeUploadInfoModal;

async function confirmUploadInfo() {
    const title = document.getElementById('upload-title').value.trim();
    if (!title) {
        showToast('곡 제목을 입력해주세요.', true);
        return;
    }

    const difficulty = parseInt(document.getElementById('upload-difficulty').value) || 5;
    const map = beatmapList[currentMapIndex];
    map.title = title;
    map.difficulty = difficulty;

    closeUploadInfoModal();

    if (!window.uploadMapToServer) {
        return showToast('저장 모듈이 로드되지 않았습니다.', true);
    }

    showUI('upload-ui');
    const progress = document.getElementById('upload-progress');
    const text = document.getElementById('upload-text');
    progress.style.width = `0%`;
    text.innerText = '연결을 준비하는 중...';

    const success = await window.uploadMapToServer(map, map.file, (percent, message) => {
        progress.style.width = `${Math.min(percent, 99)}%`;
        text.innerText = message;
    });

    if (success) {
        showToast(`${map.title} 맵이 성공적으로 업로드되었습니다!`);
        map.uploaded = true;
        if (window.loadMapsFromServer) window.loadMapsFromServer();
        renderSongList();
    }

    hideUI('upload-ui');
    showUI('song-select-ui');
}
window.confirmUploadInfo = confirmUploadInfo;

async function handleAudioUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const statusEl = document.getElementById('upload-status');
    if (statusEl) {
        statusEl.innerText = '로컬 오디오 처리 중...';
        statusEl.classList.remove('hidden');
        statusEl.classList.replace('text-green-400', 'text-yellow-400');
    }

    try {
        const objectUrl = URL.createObjectURL(file);
        beatmapList[currentMapIndex].localAudioUrl = objectUrl;
        beatmapList[currentMapIndex].file = file;
        beatmapList[currentMapIndex].title = file.name.replace(/\.[^/.]+$/, '');
        renderSongList();
        showToast('음원이 기기에 로드되었습니다. 이제 플레이하거나 녹화할 수 있습니다.');
    } catch (error) {
        showToast('오디오 로드에 실패했습니다.', true);
    }
}
window.handleAudioUpload = handleAudioUpload;

async function uploadMap() {
    if (!window.currentUser || (window.currentUser.uid && window.currentUser.uid.startsWith('guest'))) {
        showToast('로그인이 필요합니다. 맵을 업로드하려면 로그인/회원가입을 해주세요.', true);
        window.openAuthModal();
        return;
    }

    const map = beatmapList[currentMapIndex];
    if (!isOwnMap(map)) return showToast('본인이 작성한 맵만 업로드할 수 있습니다.', true);
    if (map.uploaded && !map.isLocalSaved) return showToast('이미 서버에 업로드 된 맵입니다!', true);
    if (!map.notes || map.notes.length === 0) return showToast('노트가 하나도 없습니다. 실시간 패턴 녹화를 먼저 진행하세요.', true);

    initUploadModal();
    openUploadInfoModal();
}
window.uploadMap = uploadMap;

function hideUI(uiId) {
    const el = document.getElementById(uiId);
    if (el) el.classList.add('hidden');
}

function getCurrentTime() {
    if (youtubeIsPlaying && youtubePlayer && typeof youtubePlayer.getCurrentTime === 'function') {
        const seconds = youtubePlayer.getCurrentTime();
        if (Number.isFinite(seconds)) return seconds * 1000;
    }
    if (Tone.Transport.state === 'started') return Tone.Transport.seconds * 1000;
    return (Tone.now() - audioStartTime) * 1000;
}

function loadYoutubeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (youtubeApiPromise) return youtubeApiPromise;

    youtubeApiPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timeout = window.setTimeout(() => reject(new Error('YouTube API timed out')), 10000);
        const previousReady = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            window.clearTimeout(timeout);
            if (typeof previousReady === 'function') previousReady();
            resolve(window.YT);
        };
        script.src = 'https://www.youtube.com/iframe_api';
        script.onerror = () => {
            window.clearTimeout(timeout);
            reject(new Error('YouTube API failed to load'));
        };
        document.head.appendChild(script);
    });
    return youtubeApiPromise;
}

function stopYoutubeBackground() {
    youtubeIsPlaying = false;
    youtubeVideoId = null;
    youtubeLastErrorCode = null;
    if (youtubePlayer?.destroy) youtubePlayer.destroy();
    youtubePlayer = null;
    const background = document.getElementById('youtube-background');
    if (background) {
        background.innerHTML = '';
        background.classList.add('hidden');
    }
}

async function startYoutubeBackground(videoId) {
    stopYoutubeBackground();
    const background = document.getElementById('youtube-background');
    if (!background) return false;

    background.classList.remove('hidden');
    const playerId = `youtube-player-${Date.now()}`;
    background.innerHTML = `<div id="${playerId}"></div>`;
    try {
        await loadYoutubeApi();
        await new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error('YouTube player timed out')), 10000);
            youtubePlayer = new window.YT.Player(playerId, {
                videoId,
                playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, playsinline: 1, rel: 0 },
                events: {
                    onReady: event => {
                        youtubeVideoId = videoId;
                        youtubeIsPlaying = true;
                        event.target.playVideo();
                        window.clearTimeout(timeout);
                        resolve();
                    },
                    onStateChange: event => {
                        youtubeIsPlaying = event.data === window.YT.PlayerState.PLAYING;
                    },
                    onError: () => {
                        youtubeLastErrorCode = arguments[0]?.data || null;
                        window.clearTimeout(timeout);
                        reject(new Error('YouTube video cannot be played'));
                    }
                }
            });
        });
        return true;
    } catch (error) {
        console.warn('YouTube background failed:', error);
        stopYoutubeBackground();
        return false;
    }
}

function processInput(laneIndex) {
    keyState[laneIndex] = true;
    keyPressTimes[laneIndex] = getCurrentTime();
    let currentTime = getCurrentTime();

    if (gameState === 'PLAYING') {
        const judgeTime = currentTime - settings.GLOBAL_OFFSET;
        let targetNote = activeNotes.find(n => !n.isHit && !n.isMissed && !n.isHolding && n.lane === laneIndex);
        if (targetNote) {
            const timeDiff = Math.abs(targetNote.time - judgeTime);
            if (timeDiff <= 120) {
                if (targetNote.type === 'long') {
                    targetNote.isHolding = true;
                    if (timeDiff <= 30) judge('PERFECT');
                    else if (timeDiff <= 70) judge('GREAT');
                    else judge('GOOD');
                    visualEffects.push({ lane: laneIndex, y: JUDGE_Y, time: Date.now(), type: 'hit' });
                } else {
                    targetNote.isHit = true;
                    if (timeDiff <= 30) judge('PERFECT');
                    else if (timeDiff <= 70) judge('GREAT');
                    else judge('GOOD');
                    visualEffects.push({ lane: laneIndex, y: JUDGE_Y, time: Date.now(), type: 'hit' });
                }
            }
        }
    } else if (gameState === 'RECORDING') {
        if (recordedNotes.length > 0 && Math.abs(currentTime - recordedNotes[recordedNotes.length - 1].time) <= 40) {
            currentTime = recordedNotes[recordedNotes.length - 1].time;
        }
        recordedNotes.push({ time: currentTime, lane: laneIndex, type: 'short' });
        visualEffects.push({ lane: laneIndex, y: JUDGE_Y, time: Date.now(), type: 'record' });
    }
}

function releaseInput(laneIndex) {
    if (!keyState[laneIndex]) return;
    keyState[laneIndex] = false;

    if (gameState === 'RECORDING') {
        const pressDuration = getCurrentTime() - keyPressTimes[laneIndex];
        if (pressDuration >= 250) {
            for (let i = recordedNotes.length - 1; i >= 0; i--) {
                if (recordedNotes[i].lane === laneIndex && recordedNotes[i].type === 'short') {
                    recordedNotes[i].type = 'long';
                    recordedNotes[i].duration = pressDuration;
                    break;
                }
            }
        }
    }
}

function judge(type) {
    let pts = 0;
    const judgeEl = document.getElementById('judge-display');

    if (type === 'PERFECT') { pts = 300; stats.perfect++; judgeEl.className = 'judge-text text-blue-400'; }
    else if (type === 'GREAT') { pts = 100; stats.great++; judgeEl.className = 'judge-text text-green-400'; }
    else if (type === 'GOOD') { pts = 50; stats.good++; judgeEl.className = 'judge-text text-yellow-400'; }
    else if (type === 'MISS') { pts = 0; stats.miss++; stats.combo = 0; judgeEl.className = 'judge-text text-red-500'; }

    if (type !== 'MISS') {
        stats.combo++;
        if (stats.combo > stats.maxCombo) stats.maxCombo = stats.combo;
        stats.score += pts + (stats.combo * 10);
    }

    const scoreEl = document.getElementById('score-text');
    const accEl = document.getElementById('acc-text');
    if (scoreEl) scoreEl.innerText = String(stats.score).padStart(7, '0');
    const totalHits = stats.perfect + stats.great + stats.good + stats.miss;
    const currentAcc = totalHits === 0 ? 100 : ((stats.perfect * 300 + stats.great * 100 + stats.good * 50) / (totalHits * 300)) * 100;
    if (accEl) accEl.innerText = currentAcc.toFixed(2) + '%';

    const comboEl = document.getElementById('combo-text');
    const labelEl = document.getElementById('combo-label');
    if (comboEl && labelEl) {
        if (stats.combo > 3) {
            comboEl.innerText = stats.combo;
            comboEl.style.opacity = 1;
            labelEl.style.opacity = 1;
        } else {
            comboEl.style.opacity = 0;
            labelEl.style.opacity = 0;
        }
    }

    if (judgeEl) {
        judgeEl.innerText = type;
        judgeEl.style.display = 'block';
        judgeEl.style.animation = 'none';
        judgeEl.offsetHeight;
        judgeEl.style.animation = null;
    }
}

async function startGame(mode) {
    const map = beatmapList[currentMapIndex];
    if (!map) return;

    if (APP_MODE === 'play' && mode !== 'PLAY') {
        return showToast('플레이 클라이언트에서는 플레이만 가능합니다.', true);
    }
    if (APP_MODE === 'editor' && mode === 'PLAY' && !isOwnMap(map)) {
        return showToast('에디터에서는 내 맵만 플레이테스트할 수 있습니다.', true);
    }
    if (APP_MODE === 'editor' && mode === 'RECORD' && !isOwnMap(map)) {
        return showToast('다른 사람의 맵은 녹화할 수 없습니다.', true);
    }

    showUI('game-ui');
    document.getElementById('play-hud')?.classList.add('hidden');
    document.getElementById('record-hud')?.classList.add('hidden');
    document.getElementById('record-controls')?.classList.add('hidden');

    try {
        await Tone.start();
    } catch (e) {
        console.error('Tone.start error:', e);
        showToast('오디오 초기화 에러가 발생했습니다.', true);
        return showUI('song-select-ui');
    }

    if (!beepSynth) {
        beepSynth = new Tone.PolySynth(Tone.Synth).toDestination();
        beepSynth.volume.value = -10;
    }

    if (tonePlayer) { tonePlayer.dispose(); tonePlayer = null; }
    stopYoutubeBackground();
    Tone.Transport.stop();
    Tone.Transport.cancel();
    Tone.Transport.position = 0;

    audioStartTime = Tone.now();
    visualEffects = [];

    const youtubeId = getYoutubeVideoId(map.youtubeUrl);
    if (map.youtubeUrl && !youtubeId) {
        showToast('저장된 YouTube 링크가 올바르지 않습니다.', true);
        return showUI('song-select-ui');
    }
    if (youtubeId) {
        const youtubeStarted = await startYoutubeBackground(youtubeId);
        if (!youtubeStarted) {
            showToast('유튜브 영상을 재생할 수 없습니다. 공개·임베드 허용 여부를 확인해주세요.', true);
            return showUI('song-select-ui');
        }
    }

    const urlToLoad = youtubeId ? null : (map.localAudioUrl || map.audioUrl);
    if (urlToLoad) {
        try {
            tonePlayer = new Tone.Player(urlToLoad).toDestination();
            await Tone.loaded();
        } catch (e) {
            console.error('Tone.Player load failed', e);
            showToast('오디오 로딩에 실패했습니다. (지원되지 않는 형식 등)', true);
            return showUI('song-select-ui');
        }
    }

    if (mode === 'PLAY') {
        if (!map.notes || map.notes.length === 0) {
            showToast('노트가 없는 맵입니다!', true);
            return showUI('song-select-ui');
        }

        gameState = 'PLAYING';
        document.getElementById('play-hud')?.classList.remove('hidden');
        const playableNotes = APP_MODE === 'play' ? createFourKeyPlayNotes(map.notes) : map.notes;
        activeNotes = playableNotes.map(n => new Note(n)).sort((a, b) => a.time - b.time);

        stats = { score: 0, combo: 0, maxCombo: 0, perfect: 0, great: 0, good: 0, miss: 0 };
        const scoreEl = document.getElementById('score-text');
        const accEl = document.getElementById('acc-text');
        if (scoreEl) scoreEl.innerText = '0000000';
        if (accEl) accEl.innerText = '100.00%';
        const judgeEl = document.getElementById('judge-display');
        if (judgeEl) judgeEl.style.display = 'none';
        const comboEl = document.getElementById('combo-text');
        const labelEl = document.getElementById('combo-label');
        if (comboEl) comboEl.style.opacity = 0;
        if (labelEl) labelEl.style.opacity = 0;

        if (tonePlayer) {
            tonePlayer.sync().start(0);
        } else if (!youtubeId) {
            activeNotes.forEach(note => {
                const timeInSec = (note.time / 1000) + (settings.GLOBAL_OFFSET / 1000);
                if (timeInSec >= 0) {
                    Tone.Transport.schedule((time) => {
                        beepSynth.triggerAttackRelease('C5', '32n', time);
                    }, timeInSec);
                }
            });
        }
        Tone.Transport.start();
    } else if (mode === 'RECORD') {
        gameState = 'RECORDING';
        document.getElementById('record-hud')?.classList.remove('hidden');
        document.getElementById('record-controls')?.classList.remove('hidden');
        recordedNotes = [];

        if (tonePlayer) {
            tonePlayer.sync().start(0);
        }
        Tone.Transport.start();
    }
    requestAnimationFrame(drawGame);
}
window.startGame = startGame;

function stopRecording() {
    gameState = 'MENU';

    Tone.Transport.stop();
    Tone.Transport.cancel();

    if (tonePlayer) {
        tonePlayer.dispose();
        tonePlayer = null;
    }
    stopYoutubeBackground();

    if (recordedNotes.length > 0) {
        beatmapList[currentMapIndex].notes = [...recordedNotes];
        beatmapList[currentMapIndex].uploaded = false;
        showToast(`총 ${recordedNotes.length}개의 노트가 저장되었습니다. '서버 업로드'를 눌러 공유해보세요!`);
    } else {
        showToast('기록된 노트가 없습니다.', true);
    }
    showUI('song-select-ui');
}
window.stopRecording = stopRecording;

function drawGame() {
    if (gameState !== 'PLAYING' && gameState !== 'RECORDING') return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const currentTime = getCurrentTime();
    const judgeTime = currentTime - settings.GLOBAL_OFFSET;
    const startX = (canvas.width - TOTAL_WIDTH) / 2;

    ctx.fillStyle = 'rgba(20, 20, 25, 0.8)';
    ctx.fillRect(startX, 0, TOTAL_WIDTH, canvas.height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 2;
    for (let i = 1; i < LANE_COUNT; i++) {
        ctx.beginPath();
        ctx.moveTo(startX + (LANE_WIDTH * i), 0);
        ctx.lineTo(startX + (LANE_WIDTH * i), canvas.height);
        ctx.stroke();
    }

    const laneKeys = getLaneKeys();
    for (let i = 0; i < LANE_COUNT; i++) {
        if (keyState[i]) {
            const grad = ctx.createLinearGradient(0, JUDGE_Y, 0, JUDGE_Y - 300);
            grad.addColorStop(0, gameState === 'RECORDING' ? 'rgba(255, 100, 100, 0.4)' : 'rgba(100, 200, 255, 0.4)');
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(startX + (i * LANE_WIDTH), 0, LANE_WIDTH, JUDGE_Y);
        }
        ctx.strokeStyle = keyState[i] ? 'white' : 'gray';
        ctx.lineWidth = 4;
        ctx.strokeRect(startX + (i * LANE_WIDTH), JUDGE_Y - (NOTE_HEIGHT / 2), LANE_WIDTH, NOTE_HEIGHT);

        ctx.fillStyle = 'gray';
        ctx.font = '20px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(laneKeys[i].toUpperCase(), startX + (i * LANE_WIDTH) + (LANE_WIDTH / 2), JUDGE_Y + 50);
    }

    ctx.strokeStyle = gameState === 'RECORDING' ? 'rgba(255, 100, 100, 0.5)' : 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(startX, JUDGE_Y);
    ctx.lineTo(startX + TOTAL_WIDTH, JUDGE_Y);
    ctx.stroke();

    const now = Date.now();
    visualEffects = visualEffects.filter(ef => now - ef.time < 300);
    visualEffects.forEach(ef => {
        const progress = (now - ef.time) / 300;
        ctx.fillStyle = ef.type === 'record' ? `rgba(255, 50, 50, ${1 - progress})` : `rgba(50, 200, 255, ${1 - progress})`;
        ctx.fillRect(startX + (ef.lane * LANE_WIDTH), ef.y - 10 - (progress * 20), LANE_WIDTH, 20 + (progress * 40));
    });

    if (gameState === 'PLAYING') {
        let remainingNotes = 0;
        ctx.fillStyle = '#4facfe';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00f2fe';

        for (let i = 0; i < activeNotes.length; i++) {
            const note = activeNotes[i];

            if (note.type === 'short') {
                if (!note.isHit && !note.isMissed && (judgeTime - note.time) > 120) {
                    note.isMissed = true;
                    judge('MISS');
                }
            } else if (note.type === 'long' && !note.isHit && !note.isMissed) {
                if (!note.isHolding) {
                    if ((judgeTime - note.time) > 120) {
                        note.isMissed = true;
                        judge('MISS');
                    }
                } else {
                    const endTime = note.time + note.duration;
                    if (!keyState[note.lane]) {
                        if (Math.abs(endTime - judgeTime) <= 150) {
                            note.isHit = true;
                            note.isHolding = false;
                            judge('PERFECT');
                            visualEffects.push({ lane: note.lane, y: JUDGE_Y, time: Date.now(), type: 'hit' });
                        } else {
                            note.isMissed = true;
                            note.isHolding = false;
                            judge('MISS');
                        }
                    } else if (judgeTime >= endTime - 40) {
                        note.isHit = true;
                        note.isHolding = false;
                        judge('PERFECT');
                        visualEffects.push({ lane: note.lane, y: JUDGE_Y, time: Date.now(), type: 'hit' });
                    }
                }
            }

            if (note.isHit || note.isMissed) continue;

            remainingNotes++;
            const noteY = JUDGE_Y - ((note.time - judgeTime) * settings.GAME_SPEED);

            if (noteY > canvas.height + (note.duration || 0) * settings.GAME_SPEED + 50 || noteY < -canvas.height) continue;

            ctx.beginPath();
            if (note.type === 'long') {
                if (note.isHolding) {
                    const currentHoldTime = judgeTime - note.time;
                    const remainingDuration = note.duration - currentHoldTime;
                    const noteHeight = Math.max(0, remainingDuration * settings.GAME_SPEED);
                    ctx.roundRect(startX + (note.lane * LANE_WIDTH) + 2, JUDGE_Y - noteHeight, LANE_WIDTH - 4, noteHeight, 5);
                } else {
                    const noteHeight = note.duration * settings.GAME_SPEED;
                    ctx.roundRect(startX + (note.lane * LANE_WIDTH) + 2, noteY - noteHeight, LANE_WIDTH - 4, noteHeight, 5);
                }
            } else {
                ctx.roundRect(startX + (note.lane * LANE_WIDTH) + 2, noteY - (NOTE_HEIGHT / 2), LANE_WIDTH - 4, NOTE_HEIGHT, 5);
            }
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        if (remainingNotes === 0 && activeNotes.length > 0 && (judgeTime > activeNotes[activeNotes.length - 1].time + 1000)) {
            gameState = 'RESULT';
            Tone.Transport.stop();
            Tone.Transport.cancel();
            if (tonePlayer) { tonePlayer.dispose(); tonePlayer = null; }
            stopYoutubeBackground();
            showUI('result-ui');
            document.getElementById('res-perfect').innerText = stats.perfect;
            document.getElementById('res-great').innerText = stats.great;
            document.getElementById('res-good').innerText = stats.good;
            document.getElementById('res-miss').innerText = stats.miss;
            document.getElementById('res-maxcombo').innerText = stats.maxCombo;
            document.getElementById('res-score').innerText = stats.score;
        }
    } else if (gameState === 'RECORDING') {
        ctx.fillStyle = '#ff6b6b';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ff6b6b';

        for (let i = Math.max(0, recordedNotes.length - 20); i < recordedNotes.length; i++) {
            const note = recordedNotes[i];
            const noteY = JUDGE_Y - ((currentTime - note.time) * settings.GAME_SPEED * 0.5);
            if (noteY < -canvas.height) continue;

            ctx.beginPath();
            if (note.type === 'long') {
                const noteHeight = note.duration * settings.GAME_SPEED * 0.5;
                ctx.roundRect(startX + (note.lane * LANE_WIDTH) + 2, noteY - noteHeight, LANE_WIDTH - 4, noteHeight, 5);
            } else {
                ctx.roundRect(startX + (note.lane * LANE_WIDTH) + 2, noteY - (NOTE_HEIGHT / 2), LANE_WIDTH - 4, NOTE_HEIGHT, 5);
            }
            ctx.fill();
        }
        ctx.shadowBlur = 0;
    }
    requestAnimationFrame(drawGame);
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    JUDGE_Y = canvas.height * 0.8;
}
window.addEventListener('resize', resize);
resize();
ensurePlayKeys();
updateSettingsUI();
initAuth();
