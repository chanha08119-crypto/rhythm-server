-- 기존 Supabase 설치에 유튜브 배경 영상 저장 기능을 추가합니다.
-- SQL Editor에서 한 번 실행하세요. 기존 맵 데이터는 유지됩니다.
ALTER TABLE rhythm_patterns
ADD COLUMN IF NOT EXISTS youtube_url TEXT;
