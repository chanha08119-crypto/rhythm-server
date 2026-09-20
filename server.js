const express = require('express');
const cors = require('cors');
const fs = require('fs'); // 파일을 읽고 쓰기 위한 모듈

const app = express();
const PORT = 3000;
const DATA_FILE = './maps.json'; // 맵 데이터를 저장할 파일 경로

// 미들웨어 설정
app.use(cors());
// 노트 데이터가 많으면 용량이 커질 수 있으므로 최대 10MB까지 허용
app.use(express.json({ limit: '10mb' })); 
// file://로 직접 여는 대신 로컬 웹 주소에서 에디터를 제공한다.
// YouTube 퍼가기는 재생 요청에 사이트 출처(Referer)가 필요하다.
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.send('Rhythm Game Server is Running!');
});

// [1] 곡 목록 불러오기 API (다운로드 역할)
app.get('/api/maps', (req, res) => {
    // 파일이 없으면 아직 업로드된 곡이 없는 것이므로 빈 배열 반환
    if (!fs.existsSync(DATA_FILE)) {
        return res.json([]);
    }
    // 파일이 있으면 읽어서 프론트엔드로 전달
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    res.json(JSON.parse(data));
});

// [2] 커스텀 맵 업로드 API (업로드 역할)
app.post('/api/maps', (req, res) => {
    const newMap = req.body; // 프론트엔드에서 보낸 맵 데이터(제목, 노트 배열 등)
    
    let maps = [];
    // 기존에 저장된 맵 데이터가 있다면 먼저 불러오기
    if (fs.existsSync(DATA_FILE)) {
        const data = fs.readFileSync(DATA_FILE, 'utf-8');
        maps = JSON.parse(data);
    }

    // 서버 측에서 새 맵에 고유 ID 부여 (간단히 현재 시간값 사용)
    newMap.id = 'map_' + Date.now();
    newMap.uploaded = true; // 서버에 저장됨을 표시

    // 배열에 새 맵 추가
    maps.push(newMap);

    // 다시 maps.json 파일에 보기 좋게 저장
    fs.writeFileSync(DATA_FILE, JSON.stringify(maps, null, 2));

    console.log(`새로운 맵 업로드 됨: ${newMap.title} (노트 수: ${newMap.notes.length})`);
    
    // 프론트엔드에 성공 응답 보내기
    res.json({ message: '서버 업로드 성공!', map: newMap });
});

// 서버 실행
app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
