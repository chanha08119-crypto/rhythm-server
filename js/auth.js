import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { settings, applySettingsToWindow } from './settings.js';

const supabaseUrl = 'https://whthandejodmoiqtgbdk.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndodGhhbmRlam9kbW9pcXRnYmRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MTg2NDYsImV4cCI6MjEwMzQ5NDY0Nn0.QiiFnfEQuXP7o5VfHZtvE_WQdc3H_-JmkPHDyBBB2yA';
const supabase = createClient(supabaseUrl, supabaseKey);

let currentUser = null;
let settingsSaveTimeout = null;

async function createOrGetUserProfile(email = null, password = null) {
    if (!currentUser) return;

    try {
        let data = null;
        let searchBy = 'nickname';

        if (email && email.trim()) {
            const { data: emailData } = await supabase
                .from('user_profiles')
                .select('*')
                .eq('email', email.toLowerCase())
                .limit(1);

            if (emailData && emailData.length > 0) {
                data = emailData[0];
                searchBy = 'email';
                currentUser.uid = data.user_id;
                currentUser.email = email;
            }
        }

        if (!data && currentUser.uid) {
            const { data: uidData } = await supabase
                .from('user_profiles')
                .select('*')
                .eq('user_id', currentUser.uid)
                .limit(1);

            if (uidData && uidData.length > 0) {
                data = uidData[0];
                searchBy = 'user_id';
            }
        }

        if (!data) {
            const uniqueId = currentUser.uid + '_' + Math.random().toString(36).substring(2, 10).toUpperCase();

            const { data: newProfile, error: createError } = await supabase
                .from('user_profiles')
                .insert([{
                    user_id: currentUser.uid,
                    unique_id: uniqueId,
                    nickname: currentUser.customNickname || currentUser.uid,
                    email: email && email.trim() ? email.toLowerCase() : null,
                    password: password,
                    created_at: new Date().toISOString()
                }])
                .select()
                .single();

            if (createError) throw createError;
            currentUser.uniqueId = newProfile.unique_id;
        } else {
            currentUser.uniqueId = data.unique_id;

            if (email && email.trim() && !data.email) {
                await supabase
                    .from('user_profiles')
                    .update({ email: email.toLowerCase() })
                    .eq('user_id', currentUser.uid);
            }

            if (currentUser.customNickname && currentUser.customNickname !== data.nickname) {
                await supabase
                    .from('user_profiles')
                    .update({ nickname: currentUser.customNickname })
                    .eq('user_id', currentUser.uid);
            }
        }

        window.currentUser = currentUser;
    } catch (e) {
        console.warn('사용자 프로필 생성 실패:', e.message);
        currentUser.uniqueId = currentUser.uid + '_' + Math.random().toString(36).substring(2, 10).toUpperCase();
    }
}
window.createOrGetUserProfile = createOrGetUserProfile;

async function loadUserSettings() {
    if (!currentUser || !currentUser.uid) return;

    try {
        const { data, error } = await supabase
            .from('user_settings')
            .select('*')
            .eq('user_id', currentUser.uid)
            .single();

        if (data && !error) {
            if (data.keys) settings.KEYS = JSON.parse(data.keys);
            if (data.game_speed) settings.GAME_SPEED = data.game_speed;
            if (data.global_offset !== null) settings.GLOBAL_OFFSET = data.global_offset;
            applySettingsToWindow();
        }

        if (window.updateSettingsUI) window.updateSettingsUI();
    } catch (e) {
        console.warn('사용자 설정 로드 실패:', e.message);
    }
}
window.loadUserSettings = loadUserSettings;

async function saveUserSettings() {
    if (!currentUser || !currentUser.uid) return;

    try {
        localStorage.setItem('rhythm_settings', JSON.stringify({
            keys: settings.KEYS,
            game_speed: settings.GAME_SPEED,
            global_offset: settings.GLOBAL_OFFSET
        }));
    } catch (e) {}

    try {
        const { error } = await supabase
            .from('user_settings')
            .upsert({
                user_id: currentUser.uid,
                keys: JSON.stringify(settings.KEYS),
                game_speed: settings.GAME_SPEED,
                global_offset: settings.GLOBAL_OFFSET
            }, { onConflict: 'user_id' });

        if (error) throw error;
    } catch (e) {
        console.warn('설정 저장 실패:', e.message);
    }
}
window.saveUserSettings = saveUserSettings;

function scheduleSettingsSave() {
    if (settingsSaveTimeout) clearTimeout(settingsSaveTimeout);
    settingsSaveTimeout = setTimeout(() => {
        saveUserSettings();
    }, 1000);
}
window.scheduleSettingsSave = scheduleSettingsSave;

export async function initAuth() {
    try {
        const savedSettings = localStorage.getItem('rhythm_settings');
        if (savedSettings) {
            const parsed = JSON.parse(savedSettings);
            if (parsed.keys) settings.KEYS = parsed.keys;
            if (parsed.game_speed) settings.GAME_SPEED = parsed.game_speed;
            if (parsed.global_offset !== null) settings.GLOBAL_OFFSET = parsed.global_offset;
            applySettingsToWindow();
        }
    } catch (e) {}

    const savedCustomUser = localStorage.getItem('custom_rhythm_user');
    if (savedCustomUser) {
        try {
            const userObj = JSON.parse(savedCustomUser);
            if (!userObj.email && (userObj.nickname || userObj.customNickname)) {
                localStorage.removeItem('custom_rhythm_user');
            } else if (userObj.email) {
                currentUser = { customNickname: userObj.customNickname, uid: userObj.uid, email: userObj.email };
                window.currentUser = currentUser;
                await createOrGetUserProfile(userObj.email);
                await loadUserSettings();
            }
        } catch (e) {}
    }
    window.updateUserUI();
    loadMapsFromServer();

    setInterval(() => {
        loadMapsFromServer();
    }, 10000);
}

window.updateUserUI = () => {
    const infoText = document.getElementById('user-info-text');
    const authBtn = document.getElementById('auth-btn');
    if (!infoText || !authBtn) return;

    const customNickname = currentUser?.customNickname;
    const uniqueId = currentUser?.uniqueId;

    if (customNickname) {
        infoText.innerHTML = `👤 <span class="block text-xs">${customNickname}</span><span class="text-xs text-gray-400 font-mono">${uniqueId || '로딩중...'}</span>`;
        infoText.className = 'text-sm text-gray-300 font-bold';
        authBtn.innerText = '로그아웃';
        authBtn.onclick = () => {
            localStorage.removeItem('custom_rhythm_user');
            currentUser = null;
            window.currentUser = null;
            location.reload();
        };
    } else {
        infoText.innerText = '👤 게스트';
        infoText.className = 'text-sm text-gray-300 font-bold';
        authBtn.innerText = '로그인 / 닉네임 설정';
        authBtn.onclick = () => window.openAuthModal();
    }
    if (window.updateMapInfo) window.updateMapInfo();
};

window.openAuthModal = () => document.getElementById('auth-modal').classList.remove('hidden');
window.closeAuthModal = () => document.getElementById('auth-modal').classList.add('hidden');

window.openProfileModal = () => {
    if (!currentUser || !currentUser.uid) {
        if (window.showToast) window.showToast('로그인 후 확인할 수 있습니다.', true);
        return;
    }

    document.getElementById('profile-nickname').innerText = currentUser.customNickname || '게스트';
    document.getElementById('profile-unique-id').innerText = currentUser.uniqueId || '로딩중...';
    document.getElementById('profile-keys').innerText = settings.KEYS.join(' / ').toUpperCase();
    document.getElementById('profile-speed').innerText = settings.GAME_SPEED.toFixed(1) + 'x';
    document.getElementById('profile-offset').innerText = settings.GLOBAL_OFFSET + 'ms';

    document.getElementById('profile-modal').classList.remove('hidden');
};

window.closeProfileModal = () => document.getElementById('profile-modal').classList.add('hidden');

window.copyUniqueId = () => {
    const uniqueId = document.getElementById('profile-unique-id').innerText;
    navigator.clipboard.writeText(uniqueId).then(() => {
        if (window.showToast) window.showToast('ID가 복사되었습니다!');
    }).catch(() => {
        if (window.showToast) window.showToast('복사 실패', true);
    });
};

window.loginWithEmail = async () => {
    const loginId = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value.trim();

    if (!loginId) {
        if (window.showToast) window.showToast('이메일 또는 닉네임을 입력해주세요.', true);
        return;
    }

    if (!password) {
        if (window.showToast) window.showToast('비밀번호를 입력해주세요.', true);
        return;
    }

    try {
        let existingUser = null;

        if (loginId.includes('@')) {
            const { data } = await supabase
                .from('user_profiles')
                .select('*')
                .ilike('email', loginId)
                .limit(1);
            existingUser = data && data.length > 0 ? data[0] : null;
        } else {
            let { data } = await supabase
                .from('user_profiles')
                .select('*')
                .ilike('nickname', loginId)
                .limit(1);

            if (!data || data.length === 0) {
                const res = await supabase
                    .from('user_profiles')
                    .select('*')
                    .ilike('user_id', loginId)
                    .limit(1);
                data = res.data;
            }
            existingUser = data && data.length > 0 ? data[0] : null;
        }

        if (existingUser) {
            if (existingUser.password && existingUser.password !== password) {
                if (window.showToast) window.showToast('비밀번호가 일치하지 않습니다.', true);
                return;
            } else if (!existingUser.password) {
                await supabase.from('user_profiles').update({ password: password }).eq('id', existingUser.id);
            }

            currentUser = {
                customNickname: existingUser.nickname,
                uid: existingUser.user_id,
                email: existingUser.email,
                uniqueId: existingUser.unique_id
            };
            localStorage.setItem('custom_rhythm_user', JSON.stringify({
                email: currentUser.email,
                uid: currentUser.uid,
                customNickname: currentUser.customNickname
            }));
        } else {
            if (window.showToast) window.showToast('존재하지 않는 계정입니다. 확인 후 다시 시도해주세요.', true);
            return;
        }

        window.currentUser = currentUser;
        await loadUserSettings();
        window.updateUserUI();
        window.closeAuthModal();
        document.getElementById('auth-nickname').value = '';
        document.getElementById('auth-email').value = '';
        document.getElementById('auth-password').value = '';
        if (window.showToast) window.showToast(`${currentUser.customNickname}님으로 로그인되었습니다.`);
        loadMapsFromServer();
    } catch (e) {
        console.warn('로그인 실패:', e.message);
        if (window.showToast) window.showToast('로그인 실패: ' + e.message, true);
    }
};

window.signUpWithEmail = async () => {
    const email = document.getElementById('auth-email').value.trim();
    const nickname = document.getElementById('auth-nickname').value.trim();
    const password = document.getElementById('auth-password').value.trim();

    if (!email || !email.includes('@')) {
        if (window.showToast) window.showToast('회원가입 시 유효한 이메일을 입력해주세요.', true);
        return;
    }
    if (!nickname) {
        if (window.showToast) window.showToast('닉네임을 입력해주세요.', true);
        return;
    }
    if (nickname.length < 2 || nickname.length > 12) {
        if (window.showToast) window.showToast('닉네임은 2자 이상, 12자 이하로 입력해주세요.', true);
        return;
    }
    if (!password) {
        if (window.showToast) window.showToast('비밀번호를 입력해주세요.', true);
        return;
    }

    try {
        const { data: existingUser } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('email', email.toLowerCase())
            .limit(1);

        if (existingUser && existingUser.length > 0) {
            if (window.showToast) window.showToast('이미 가입된 이메일입니다. 로그인해주세요.', true);
            return;
        }

        const { data: existingNickname } = await supabase
            .from('user_profiles')
            .select('nickname')
            .eq('nickname', nickname)
            .limit(1);

        if (existingNickname && existingNickname.length > 0) {
            if (window.showToast) window.showToast('이미 사용 중인 닉네임입니다. 다른 닉네임을 사용해주세요.', true);
            return;
        }

        currentUser = {
            customNickname: nickname,
            uid: email.toLowerCase(),
            email: email.toLowerCase()
        };
        window.currentUser = currentUser;

        await createOrGetUserProfile(email, password);
        await loadUserSettings();

        localStorage.setItem('custom_rhythm_user', JSON.stringify({
            email: currentUser.email,
            uid: currentUser.uid,
            customNickname: currentUser.customNickname
        }));

        window.updateUserUI();
        window.closeAuthModal();
        document.getElementById('auth-nickname').value = '';
        document.getElementById('auth-email').value = '';
        document.getElementById('auth-password').value = '';
        if (window.showToast) window.showToast(`회원가입 완료! ${currentUser.customNickname}님 환영합니다.`);
        loadMapsFromServer();
    } catch (e) {
        console.warn('회원가입 실패:', e.message);
        if (window.showToast) window.showToast('회원가입 실패: ' + e.message, true);
    }
};

window.loginAsGuest = () => {
    currentUser = {
        customNickname: '게스트',
        uid: 'guest_' + Math.random().toString(36).substring(2, 8),
        uniqueId: 'guest_' + Math.random().toString(36).substring(2, 10)
    };
    window.currentUser = currentUser;
    window.updateUserUI();
    window.closeAuthModal();
    if (window.showToast) window.showToast('게스트 모드로 시작합니다.');
    loadMapsFromServer();
};

async function loadMapsFromServer() {
    try {
        const { data, error } = await supabase
            .from('rhythm_patterns')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const serverMaps = data.map(item => ({
            id: item.id,
            user_id: item.user_id || 'guest',
            creator_unique_id: item.creator_unique_id || null,
            title: item.title || 'Unknown',
            difficulty: item.difficulty || 5,
            creator: item.creator_name || '익명',
            uploaded: true,
            notes: typeof item.notes === 'string' ? JSON.parse(item.notes) : (item.notes || []),
            audioUrl: item.music || null,
            youtubeUrl: item.youtube_url || null
        }));

        const localMaps = getLocalMaps();
        const serverMapIds = new Set(serverMaps.map(m => m.id));
        const combinedMaps = [...serverMaps, ...localMaps.filter(lm => !serverMapIds.has(lm.id))];

        if (window.updateServerMaps) window.updateServerMaps(combinedMaps);
    } catch (e) {
        console.warn('서버 맵 로드 에러:', e.message);
        if (window.updateServerMaps) window.updateServerMaps(getLocalMaps());
    }
}
window.loadMapsFromServer = loadMapsFromServer;

window.uploadMapToServer = async (mapData, fileData, progressCallback) => {
    if (!currentUser || !currentUser.uid) {
        progressCallback(100, '오류: 닉네임 설정이 필요합니다.');
        return false;
    }

    progressCallback(20, '데이터 준비 중...');
    let audioUrl = mapData.audioUrl || null;
    const uid = currentUser.uid;

    if (fileData) {
        progressCallback(50, '오디오 파일 업로드 중... (용량에 따라 수십 초 소요)');
        try {
            const fileExt = fileData.name.split('.').pop();
            const safeName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;

            const { error: uploadError } = await supabase.storage
                .from('songs')
                .upload(safeName, fileData);

            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage
                .from('songs')
                .getPublicUrl(safeName);

            audioUrl = publicUrlData.publicUrl;
        } catch (error) {
            console.error('Audio upload failed:', error);
            progressCallback(100, '오디오 파일 업로드 실패: ' + error.message);
            return false;
        }
    }

    if (!currentUser.uniqueId) {
        progressCallback(100, '오류: 로그인 정보가 부족합니다. 다시 로그인해주세요.');
        return false;
    }

    const insertData = {
        title: mapData.title,
        notes: typeof mapData.notes === 'string' ? mapData.notes : JSON.stringify(mapData.notes),
        music: audioUrl,
        user_id: uid,
        creator_name: currentUser.customNickname || uid,
        creator_unique_id: currentUser.uniqueId,
        difficulty: mapData.difficulty || 5,
        youtube_url: mapData.youtubeUrl || null
    };

    try {
        progressCallback(80, '서버 DB 등록 중...');

        let { data, error } = await supabase
            .from('rhythm_patterns')
            .insert([insertData])
            .select();

        if (error) {
            const fallback2 = {
                title: mapData.title,
                notes: insertData.notes,
                music: audioUrl,
                user_id: uid,
                creator_name: currentUser.customNickname || uid,
                difficulty: mapData.difficulty || 5,
                youtube_url: mapData.youtubeUrl || null
            };

            const retry2 = await supabase.from('rhythm_patterns').insert([fallback2]).select();
            if (retry2.error) {
                const fallback3 = {
                    title: mapData.title,
                    notes: insertData.notes,
                    music: audioUrl,
                    user_id: uid,
                    difficulty: mapData.difficulty || 5
                };

                const retry3 = await supabase.from('rhythm_patterns').insert([fallback3]).select();
                if (retry3.error) {
                    const fallback4 = {
                        title: mapData.title,
                        notes: insertData.notes,
                        music: audioUrl,
                        difficulty: mapData.difficulty || 5
                    };

                    const retry4 = await supabase.from('rhythm_patterns').insert([fallback4]).select();
                    if (retry4.error) {
                        const fallback5 = {
                            title: mapData.title,
                            notes: insertData.notes,
                            music: audioUrl
                        };

                        const retry5 = await supabase.from('rhythm_patterns').insert([fallback5]).select();
                        if (retry5.error) throw retry5.error;
                        data = retry5.data;
                    } else {
                        data = retry4.data;
                    }
                } else {
                    data = retry3.data;
                }
            } else {
                data = retry2.data;
            }
        }

        progressCallback(100, '서버 업로드 및 공유 완료!');
        return true;
    } catch (error) {
        console.error('DB 저장 완전 실패:', error);
        progressCallback(100, 'DB 저장 실패: ' + error.message);
        return false;
    }
};

window.deleteMapFromServer = async (mapId) => {
    deleteLocalMap(mapId);
    try {
        await supabase.from('rhythm_patterns').delete().eq('id', mapId);
    } catch (e) {
        console.warn('삭제 에러:', e.message);
    }
    return true;
};

window.updateMapInServer = async (mapId, updatedMeta) => {
    const localMaps = getLocalMaps();
    const target = localMaps.find(m => m.id === mapId);
    if (target) {
        target.title = updatedMeta.title;
        target.difficulty = updatedMeta.difficulty;
        target.artist = updatedMeta.artist;
        target.youtubeUrl = updatedMeta.youtubeUrl || null;
        saveLocalMap(target);
    }
    try {
        let { error } = await supabase.from('rhythm_patterns').update({
            title: updatedMeta.title,
            difficulty: updatedMeta.difficulty,
            youtube_url: updatedMeta.youtubeUrl || null
        }).eq('id', mapId);

        if (error) {
            let retry = await supabase.from('rhythm_patterns').update({
                title: updatedMeta.title,
                difficulty: updatedMeta.difficulty
            }).eq('id', mapId);
            if (retry.error) console.warn('맵 정보 수정 완전 실패:', retry.error.message);
        }
    } catch (e) {
        console.warn('수정 에러:', e.message);
    }
    return true;
};

function getLocalMaps() {
    try {
        return JSON.parse(localStorage.getItem('local_rhythm_maps') || '[]');
    } catch (e) {
        return [];
    }
}

function saveLocalMap(mapItem) {
    try {
        const maps = getLocalMaps();
        const existingIdx = maps.findIndex(m => m.id === mapItem.id);
        if (existingIdx >= 0) maps[existingIdx] = mapItem;
        else maps.push(mapItem);
        localStorage.setItem('local_rhythm_maps', JSON.stringify(maps));
    } catch (e) {}
}

function deleteLocalMap(mapId) {
    try {
        const maps = getLocalMaps().filter(m => m.id !== mapId);
        localStorage.setItem('local_rhythm_maps', JSON.stringify(maps));
    } catch (e) {}
}

window.getLocalMaps = getLocalMaps;
window.saveLocalMap = saveLocalMap;
window.deleteLocalMap = deleteLocalMap;
