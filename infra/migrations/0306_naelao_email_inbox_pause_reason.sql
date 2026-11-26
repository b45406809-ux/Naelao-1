-- MS-41: why an inbox's sending is paused, so a Managed subscription recovery only lifts its own pause
-- (never an operator or abuse pause). NULL for inboxes paused before this column existed.
ALTER TABLE nemail_inboxes ADD COLUMN sending_pause_reason TEXT;
