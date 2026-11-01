ALTER TABLE space_blackboard_wakes
  ADD COLUMN dispatch_accepted INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_accepted IN (0,1));
