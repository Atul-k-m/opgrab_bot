-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/ekxippfiaczzcloyfbyi/sql/new

-- 1. Add location column (text, nullable)
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS location TEXT;

-- 2. Add tags column (text array, default empty array)
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- 3. (Optional but recommended) Add index on source + location for fast filtering
CREATE INDEX IF NOT EXISTS idx_opp_source ON opportunities (source);
CREATE INDEX IF NOT EXISTS idx_opp_location ON opportunities (location);

-- 4. Verify the schema looks right
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'opportunities'
ORDER BY ordinal_position;
