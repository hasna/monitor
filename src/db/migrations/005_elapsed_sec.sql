-- Add elapsed_sec to processes table for stuck-process detection
ALTER TABLE processes ADD COLUMN elapsed_sec INTEGER;
