-- Add elapsed_sec to processes table for stuck-process detection
ALTER TABLE processes ADD COLUMN IF NOT EXISTS elapsed_sec INTEGER;
