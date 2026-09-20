-- ========================================
-- Rhythm Game - Supabase 테이블 설정
-- ========================================
-- 이 SQL을 Supabase SQL Editor에서 **전체 선택 후 한 번에 실행**하세요
-- ⚠️ 주의: rhythm_patterns 테이블이 있으면 DROP되므로 데이터 백업 권장

-- ========== 1단계: 기존 테이블 정리 ==========
DROP TABLE IF EXISTS rhythm_patterns CASCADE;

-- ========== 2단계: 테이블 생성 ==========
-- 1. 사용자 프로필 테이블 (고유 ID 저장, 이메일 기반 중복 방지)
CREATE TABLE IF NOT EXISTS user_profiles (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  unique_id TEXT NOT NULL UNIQUE,
  nickname TEXT,
  email TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. 사용자 설정 테이블
CREATE TABLE IF NOT EXISTS user_settings (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  keys JSONB DEFAULT '["d", "f", "j"]',
  game_speed DECIMAL(3,1) DEFAULT 1.5,
  global_offset INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. 리듬 패턴 테이블 (맵 저장)
CREATE TABLE rhythm_patterns (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  difficulty INTEGER DEFAULT 1,  -- 난이도 (1~10)
  notes JSONB NOT NULL DEFAULT '[]',
  music TEXT,
  youtube_url TEXT,
  user_id TEXT,
  creator_name TEXT,
  creator_unique_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========== 3단계: 인덱스 생성 (빠른 조회) ==========
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_unique_id ON user_profiles(unique_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_rhythm_patterns_creator_unique_id ON rhythm_patterns(creator_unique_id);
CREATE INDEX IF NOT EXISTS idx_rhythm_patterns_user_id ON rhythm_patterns(user_id);
CREATE INDEX IF NOT EXISTS idx_rhythm_patterns_created_at ON rhythm_patterns(created_at DESC);

-- ========================================
-- 🎵 Storage 버킷 설정 (SQL에서 할 수 없음)
-- ========================================
-- Supabase 대시보시oard → Storage → Create new bucket
-- 버킷명: songs
-- Public: ON (누구나 음원 재생 가능)

-- ========================================
-- 테스트 데이터 (선택사항, 주석 제거 후 실행)
-- ========================================
-- INSERT INTO user_profiles (user_id, unique_id, nickname, email)
-- VALUES 
--   ('testuser', 'testuser_ABC12345', 'Test User', 'test@example.com'),
--   ('admin', 'admin_XYZ67890', 'Admin', 'admin@example.com');

-- INSERT INTO user_settings (user_id, keys, game_speed, global_offset)
-- VALUES 
--   ('testuser', '["d", "f", "j"]', 1.5, 0),
--   ('admin', '["d", "f", "j"]', 1.5, 0);

-- INSERT INTO rhythm_patterns (title, notes, user_id, creator_name, creator_unique_id)
-- VALUES 
--   ('테스트 곡', '[]', 'testuser', 'Test User', 'testuser_ABC12345');

-- ========================================
-- 확인 쿼리 (실행하여 생성 확인)
-- ========================================
-- SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
-- SELECT * FROM user_profiles LIMIT 5;
-- SELECT * FROM user_settings LIMIT 5;
-- SELECT id, title, creator_name, creator_unique_id FROM rhythm_patterns LIMIT 5;
