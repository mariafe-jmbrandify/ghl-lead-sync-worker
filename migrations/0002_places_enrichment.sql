-- Business details from the GHL webhook, used to look the lead up on Google Places.
ALTER TABLE leads ADD COLUMN company_name TEXT;
ALTER TABLE leads ADD COLUMN address1     TEXT;
ALTER TABLE leads ADD COLUMN city         TEXT;
ALTER TABLE leads ADD COLUMN state        TEXT;

-- Google Places (Text Search) result for the lead's business.
ALTER TABLE leads ADD COLUMN place_id           TEXT;
ALTER TABLE leads ADD COLUMN place_name         TEXT;
ALTER TABLE leads ADD COLUMN place_address      TEXT;
ALTER TABLE leads ADD COLUMN place_rating       REAL;
ALTER TABLE leads ADD COLUMN place_rating_count INTEGER;
ALTER TABLE leads ADD COLUMN place_website      TEXT;

-- 'pending' | 'found' | 'not_found' | 'skipped' | 'failed'
ALTER TABLE leads ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE leads ADD COLUMN enrichment_error  TEXT;
ALTER TABLE leads ADD COLUMN enriched_at       TEXT;

-- Leads already in the sheet will never be enriched.
UPDATE leads SET enrichment_status = 'skipped' WHERE synced_at IS NOT NULL;
