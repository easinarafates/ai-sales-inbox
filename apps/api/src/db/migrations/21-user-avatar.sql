-- 21-user-avatar.sql — profile photo for the shop owner/user.
-- The header Profile menu lets the logged-in user pick a photo
-- (POST /api/profile/photo). Stored as a plain URL (a public Vercel
-- Blob URL on production, a local /api/uploads/... URL in local dev) —
-- never invented: NULL means "no photo yet", and the header then shows
-- the user's initials instead.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
