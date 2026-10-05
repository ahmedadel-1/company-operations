-- AlterTable
ALTER TABLE "request_effects" ADD COLUMN     "ends_at_minute" SMALLINT,
ADD COLUMN     "starts_at_minute" SMALLINT;

-- CreateTable
CREATE TABLE "attendance_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "max_accuracy_meters" INTEGER NOT NULL,
    "low_accuracy_action" "AttendanceAccuracyAction" NOT NULL,
    "missing_location_action" "AttendanceAccuracyAction" NOT NULL DEFAULT 'REJECT',
    "missing_checkout_after_minutes" INTEGER NOT NULL DEFAULT 240,
    "configured_by_member_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attendance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,
    "crosses_midnight" BOOLEAN NOT NULL,
    "late_grace_minutes" SMALLINT NOT NULL DEFAULT 0,
    "early_leave_grace_minutes" SMALLINT NOT NULL DEFAULT 0,
    "weekdays" SMALLINT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_shift_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_by_member_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "time_zone" TEXT NOT NULL,
    "mode" "AttendanceMode",
    "status" "AttendanceRecordStatus" NOT NULL DEFAULT 'OPEN',
    "shift_id" UUID,
    "shift_name" TEXT,
    "shift_start_minute" SMALLINT,
    "shift_end_minute" SMALLINT,
    "shift_crosses_midnight" BOOLEAN,
    "late_grace_minutes" SMALLINT,
    "early_leave_grace_minutes" SMALLINT,
    "scheduled_start_at" TIMESTAMPTZ(6),
    "scheduled_end_at" TIMESTAMPTZ(6),
    "check_in_at" TIMESTAMPTZ(6),
    "check_out_at" TIMESTAMPTZ(6),
    "check_in_location_id" UUID,
    "check_out_location_id" UUID,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_leave_minutes" INTEGER NOT NULL DEFAULT 0,
    "worked_minutes" INTEGER,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "adjusted" BOOLEAN NOT NULL DEFAULT false,
    "source_request_id" UUID,
    "missing_checkout_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "kind" "AttendanceEventKind" NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_at" TIMESTAMPTZ(6),
    "work_date" DATE NOT NULL,
    "mode" "AttendanceMode",
    "work_location_id" UUID,
    "latitude" DECIMAL(7,5),
    "longitude" DECIMAL(8,5),
    "accuracy_meters" INTEGER,
    "distance_meters" INTEGER,
    "allowed_radius_meters" INTEGER,
    "accuracy_threshold_meters" INTEGER,
    "geofence_result" "AttendanceGeofenceResult",
    "review_status" "AttendanceReviewStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "reviewed_by_member_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "actor_member_id" UUID,
    "request_id" UUID,
    "request_effect_id" UUID,
    "adjustment_id" UUID,
    "previous_check_in_at" TIMESTAMPTZ(6),
    "previous_check_out_at" TIMESTAMPTZ(6),
    "adjusted_check_in_at" TIMESTAMPTZ(6),
    "adjusted_check_out_at" TIMESTAMPTZ(6),
    "reason_code" "AttendanceAdjustmentReason",
    "note" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "key_owner_member_id" UUID,

    CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_adjustment_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "requester_member_id" UUID NOT NULL,
    "record_id" UUID,
    "work_date" DATE NOT NULL,
    "reason_code" "AttendanceAdjustmentReason" NOT NULL,
    "requested_check_in_at" TIMESTAMPTZ(6),
    "requested_check_out_at" TIMESTAMPTZ(6),
    "original_check_in_at" TIMESTAMPTZ(6),
    "original_check_out_at" TIMESTAMPTZ(6),
    "details" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(6),
    "reverted_at" TIMESTAMPTZ(6),
    "idempotency_key" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_adjustment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_organization_id_key" ON "attendance_policies"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_policies_organization_id_id_key" ON "attendance_policies"("organization_id", "id");

-- CreateIndex
CREATE INDEX "shifts_organization_id_active_idx" ON "shifts"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_organization_id_id_key" ON "shifts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_organization_id_name_key" ON "shifts"("organization_id", "name");

-- CreateIndex
CREATE INDEX "employee_shift_assignments_organization_id_profile_id_effec_idx" ON "employee_shift_assignments"("organization_id", "profile_id", "effective_from");

-- CreateIndex
CREATE INDEX "employee_shift_assignments_organization_id_shift_id_idx" ON "employee_shift_assignments"("organization_id", "shift_id");

-- CreateIndex
CREATE INDEX "employee_shift_assignments_organization_id_created_by_membe_idx" ON "employee_shift_assignments"("organization_id", "created_by_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_shift_assignments_organization_id_id_key" ON "employee_shift_assignments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "attendance_records_organization_id_work_date_status_idx" ON "attendance_records"("organization_id", "work_date", "status");

-- CreateIndex
CREATE INDEX "attendance_records_organization_id_member_id_work_date_idx" ON "attendance_records"("organization_id", "member_id", "work_date" DESC);

-- CreateIndex
CREATE INDEX "attendance_records_organization_id_status_scheduled_end_at_idx" ON "attendance_records"("organization_id", "status", "scheduled_end_at");

-- CreateIndex
CREATE INDEX "attendance_records_organization_id_shift_id_idx" ON "attendance_records"("organization_id", "shift_id");

-- CreateIndex
CREATE INDEX "attendance_records_organization_id_check_in_location_id_idx" ON "attendance_records"("organization_id", "check_in_location_id");

-- CreateIndex
CREATE INDEX "attendance_records_organization_id_check_out_location_id_idx" ON "attendance_records"("organization_id", "check_out_location_id");

-- CreateIndex
CREATE INDEX "attendance_records_organization_id_source_request_id_idx" ON "attendance_records"("organization_id", "source_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_organization_id_id_key" ON "attendance_records"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_organization_id_profile_id_work_date_key" ON "attendance_records"("organization_id", "profile_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_record_id_recorded_at_id_idx" ON "attendance_events"("organization_id", "record_id", "recorded_at", "id");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_profile_id_recorded_at_idx" ON "attendance_events"("organization_id", "profile_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_review_status_recorded_at_idx" ON "attendance_events"("organization_id", "review_status", "recorded_at");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_recorded_at_idx" ON "attendance_events"("organization_id", "recorded_at");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_work_location_id_idx" ON "attendance_events"("organization_id", "work_location_id");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_reviewed_by_member_id_idx" ON "attendance_events"("organization_id", "reviewed_by_member_id");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_actor_member_id_idx" ON "attendance_events"("organization_id", "actor_member_id");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_request_id_idx" ON "attendance_events"("organization_id", "request_id");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_request_effect_id_idx" ON "attendance_events"("organization_id", "request_effect_id");

-- CreateIndex
CREATE INDEX "attendance_events_organization_id_adjustment_id_idx" ON "attendance_events"("organization_id", "adjustment_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_events_organization_id_id_key" ON "attendance_events"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_events_organization_id_idempotency_key_key" ON "attendance_events"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "attendance_adjustment_requests_organization_id_profile_id_w_idx" ON "attendance_adjustment_requests"("organization_id", "profile_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_adjustment_requests_organization_id_record_id_idx" ON "attendance_adjustment_requests"("organization_id", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_adjustment_requests_organization_id_id_key" ON "attendance_adjustment_requests"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_adjustment_requests_organization_id_request_id_key" ON "attendance_adjustment_requests"("organization_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_adjustment_requests_organization_id_requester_me_key" ON "attendance_adjustment_requests"("organization_id", "requester_member_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_organization_id_configured_by_member_i_fkey" FOREIGN KEY ("organization_id", "configured_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_organization_id_profile_id_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_organization_id_created_by_memb_fkey" FOREIGN KEY ("organization_id", "created_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_profile_id_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_shift_id_fkey" FOREIGN KEY ("organization_id", "shift_id") REFERENCES "shifts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_check_in_location_id_fkey" FOREIGN KEY ("organization_id", "check_in_location_id") REFERENCES "work_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_check_out_location_id_fkey" FOREIGN KEY ("organization_id", "check_out_location_id") REFERENCES "work_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_source_request_id_fkey" FOREIGN KEY ("organization_id", "source_request_id") REFERENCES "request_instances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_record_id_fkey" FOREIGN KEY ("organization_id", "record_id") REFERENCES "attendance_records"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_profile_id_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_work_location_id_fkey" FOREIGN KEY ("organization_id", "work_location_id") REFERENCES "work_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_reviewed_by_member_id_fkey" FOREIGN KEY ("organization_id", "reviewed_by_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_actor_member_id_fkey" FOREIGN KEY ("organization_id", "actor_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_request_id_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "request_instances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_request_effect_id_fkey" FOREIGN KEY ("organization_id", "request_effect_id") REFERENCES "request_effects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_organization_id_adjustment_id_fkey" FOREIGN KEY ("organization_id", "adjustment_id") REFERENCES "attendance_adjustment_requests"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_adjustment_requests" ADD CONSTRAINT "attendance_adjustment_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_adjustment_requests" ADD CONSTRAINT "attendance_adjustment_requests_organization_id_profile_id_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "employee_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_adjustment_requests" ADD CONSTRAINT "attendance_adjustment_requests_organization_id_requester_m_fkey" FOREIGN KEY ("organization_id", "requester_member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_adjustment_requests" ADD CONSTRAINT "attendance_adjustment_requests_organization_id_record_id_fkey" FOREIGN KEY ("organization_id", "record_id") REFERENCES "attendance_records"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attendance_adjustment_requests" ADD CONSTRAINT "attendance_adjustment_requests_organization_id_request_id_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "request_instances"("organization_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written: domain CHECK constraints (ADR-0022).
ALTER TABLE "request_effects" ADD CONSTRAINT "request_effects_window_check"
  CHECK (("starts_at_minute" IS NULL) = ("ends_at_minute" IS NULL)
    AND ("starts_at_minute" IS NULL OR ("mode" = 'SHORT_LEAVE'
      AND "starts_at_minute" BETWEEN 0 AND 1439 AND "ends_at_minute" BETWEEN 1 AND 1440
      AND "ends_at_minute" > "starts_at_minute")));

ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_action_check"
  CHECK (("category" = 'ATTENDANCE_COORDINATES') = ("action" = 'NULL_COORDINATES'));

ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_values_check"
  CHECK ("max_accuracy_meters" BETWEEN 10 AND 5000
    AND "missing_checkout_after_minutes" BETWEEN 30 AND 1440 AND "version" >= 1);

ALTER TABLE "shifts" ADD CONSTRAINT "shifts_values_check"
  CHECK (length("name") BETWEEN 1 AND 120
    AND "start_minute" BETWEEN 0 AND 1439 AND "end_minute" BETWEEN 0 AND 1439
    AND "start_minute" <> "end_minute"
    AND "crosses_midnight" = ("end_minute" < "start_minute")
    AND "late_grace_minutes" BETWEEN 0 AND 240 AND "early_leave_grace_minutes" BETWEEN 0 AND 240
    AND "weekdays" IS NOT NULL AND cardinality("weekdays") BETWEEN 1 AND 7
    AND "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
    AND "version" >= 1);

ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_dates_check"
  CHECK (("effective_to" IS NULL OR "effective_to" >= "effective_from") AND "version" >= 1);
-- One applicable shift per employee and day: no two assignments of a profile may overlap.
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_no_overlap"
  EXCLUDE USING gist ("organization_id" WITH =, "profile_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&);

ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_values_check"
  CHECK (length("time_zone") BETWEEN 1 AND 64
    AND "late_minutes" >= 0 AND "early_leave_minutes" >= 0
    AND ("worked_minutes" IS NULL OR "worked_minutes" >= 0)
    AND ("check_out_at" IS NULL OR ("check_in_at" IS NOT NULL AND "check_out_at" >= "check_in_at"))
    AND ("shift_id" IS NULL) = ("shift_start_minute" IS NULL)
    AND ("shift_start_minute" IS NULL) = ("shift_end_minute" IS NULL)
    AND ("shift_start_minute" IS NULL) = ("scheduled_start_at" IS NULL)
    AND ("scheduled_start_at" IS NULL) = ("scheduled_end_at" IS NULL)
    AND ("scheduled_end_at" IS NULL OR "scheduled_end_at" > "scheduled_start_at")
    AND ("status" <> 'MISSING_CHECKOUT' OR "missing_checkout_at" IS NOT NULL)
    AND "version" >= 1);

ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_values_check"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL)
    AND ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180))
    AND ("accuracy_meters" IS NULL OR "accuracy_meters" >= 0)
    AND ("distance_meters" IS NULL OR "distance_meters" >= 0)
    AND ("allowed_radius_meters" IS NULL OR "allowed_radius_meters" > 0)
    AND ("accuracy_threshold_meters" IS NULL OR "accuracy_threshold_meters" > 0)
    AND length("idempotency_key") BETWEEN 1 AND 128
    AND ("user_agent" IS NULL OR length("user_agent") <= 512)
    AND ("ip_address" IS NULL OR length("ip_address") <= 64)
    AND ("note" IS NULL OR length("note") <= 1000)
    AND ("review_note" IS NULL OR length("review_note") <= 1000));
-- Live check-ins/outs always carry a geofence result; other kinds never do.
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_result_check"
  CHECK (("kind" IN ('CHECK_IN', 'CHECK_OUT')) = ("geofence_result" IS NOT NULL));
-- Poor accuracy is never strong evidence (SECURITY section 9): INSIDE requires accuracy within the threshold.
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_inside_accuracy_check"
  CHECK ("geofence_result" IS DISTINCT FROM 'INSIDE'
    OR ("accuracy_meters" IS NOT NULL AND "accuracy_threshold_meters" IS NOT NULL
      AND "accuracy_meters" <= "accuracy_threshold_meters" AND "distance_meters" <= "allowed_radius_meters"));
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_review_check"
  CHECK (("review_status" IN ('ACCEPTED', 'REJECTED')) = ("reviewed_at" IS NOT NULL AND "reviewed_by_member_id" IS NOT NULL));
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_adjusted_check"
  CHECK ("kind" NOT IN ('ADJUSTED', 'ADJUSTMENT_REVERTED') OR "reason_code" IS NOT NULL);

ALTER TABLE "attendance_adjustment_requests" ADD CONSTRAINT "attendance_adjustment_requests_values_check"
  CHECK (("requested_check_in_at" IS NOT NULL OR "requested_check_out_at" IS NOT NULL)
    AND ("requested_check_in_at" IS NULL OR "requested_check_out_at" IS NULL
      OR "requested_check_out_at" > "requested_check_in_at")
    AND length("details") BETWEEN 1 AND 2000
    AND ("reverted_at" IS NULL OR "applied_at" IS NOT NULL));

-- Hand-written: attendance evidence is append-only (SECURITY section 8, ADR-0022). Two narrow
-- exceptions: a pending review may be decided once (review columns only), and the retention function
-- may clear coordinates (it runs as its owner and raises a transaction-local flag, which a session
-- cannot use for itself).
CREATE FUNCTION "guard_attendance_event"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."review_status" = 'PENDING_REVIEW' AND NEW."review_status" IN ('ACCEPTED', 'REJECTED')
       AND (to_jsonb(NEW) - 'review_status' - 'reviewed_by_member_id' - 'reviewed_at' - 'review_note')
         = (to_jsonb(OLD) - 'review_status' - 'reviewed_by_member_id' - 'reviewed_at' - 'review_note') THEN
      RETURN NEW;
    END IF;
    IF current_setting('ops.retention_purge', true) = 'on' AND current_user <> session_user
       AND NEW."latitude" IS NULL AND NEW."longitude" IS NULL
       AND (to_jsonb(NEW) - 'latitude' - 'longitude') = (to_jsonb(OLD) - 'latitude' - 'longitude') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "attendance_events_append_only" BEFORE UPDATE OR DELETE ON "attendance_events"
  FOR EACH ROW EXECUTE FUNCTION "guard_attendance_event"();
CREATE TRIGGER "attendance_events_no_truncate" BEFORE TRUNCATE ON "attendance_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();

-- A correction's requested and original values are immutable; it can only be marked applied, then
-- reverted, once each. Never deleted.
CREATE FUNCTION "guard_attendance_adjustment"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (OLD."applied_at" IS NULL OR NEW."applied_at" = OLD."applied_at")
     AND (OLD."reverted_at" IS NULL OR NEW."reverted_at" = OLD."reverted_at")
     AND (to_jsonb(NEW) - 'applied_at' - 'reverted_at' - 'record_id')
       = (to_jsonb(OLD) - 'applied_at' - 'reverted_at' - 'record_id')
     AND (OLD."record_id" IS NULL OR NEW."record_id" = OLD."record_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'attendance adjustment % cannot be changed (% rejected)', OLD."id", TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "attendance_adjustments_guarded" BEFORE UPDATE OR DELETE ON "attendance_adjustment_requests"
  FOR EACH ROW EXECUTE FUNCTION "guard_attendance_adjustment"();
CREATE TRIGGER "attendance_adjustments_no_truncate" BEFORE TRUNCATE ON "attendance_adjustment_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "attendance_records_no_delete" BEFORE DELETE ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION "forbid_append_only_mutation"();
CREATE TRIGGER "attendance_records_no_truncate" BEFORE TRUNCATE ON "attendance_records"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_append_only_mutation"();

-- Hand-written: bounded, tenant-scoped coordinate retention (ADR-0022). Does nothing unless the
-- organization has an explicit ATTENDANCE_COORDINATES policy. Clears latitude/longitude only; the
-- event, its result, distance, accuracy, location and times stay. Events awaiting review and records
-- with an open correction are skipped until resolved.
CREATE FUNCTION "purge_attendance_coordinates"(p_org uuid, p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_days integer;
  v_cutoff timestamptz;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 0), 0), 5000);
  v_count integer := 0;
BEGIN
  SELECT "retain_days" INTO v_days FROM "retention_policies"
    WHERE "organization_id" = p_org AND "category" = 'ATTENDANCE_COORDINATES' AND "action" = 'NULL_COORDINATES';
  IF v_days IS NULL OR v_limit = 0 THEN
    RETURN 0;
  END IF;
  v_cutoff := now() - make_interval(days => v_days);
  PERFORM set_config('ops.retention_purge', 'on', true);
  UPDATE "attendance_events" SET "latitude" = NULL, "longitude" = NULL WHERE "id" IN (
    SELECT ev."id" FROM "attendance_events" ev
     WHERE ev."organization_id" = p_org AND ev."latitude" IS NOT NULL AND ev."recorded_at" < v_cutoff
       AND ev."review_status" <> 'PENDING_REVIEW'
       AND NOT EXISTS (
         SELECT 1 FROM "attendance_adjustment_requests" a
           JOIN "request_instances" r ON r."organization_id" = a."organization_id" AND r."id" = a."request_id"
          WHERE a."organization_id" = ev."organization_id" AND a."record_id" = ev."record_id"
            AND r."status" IN ('DRAFT', 'PENDING_APPROVAL'))
     ORDER BY ev."recorded_at" LIMIT v_limit);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('ops.retention_purge', 'off', true);
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION "purge_attendance_coordinates"(uuid, integer) FROM PUBLIC;

-- Hand-written: least privilege for the runtime role (SECURITY section 8). Events: insert, plus update
-- of the review columns only (the trigger narrows it further). Records, shifts, assignments, policies
-- and corrections are never deleted. Skipped where the role does not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "attendance_events" FROM ops_app;
    GRANT UPDATE ("review_status", "reviewed_by_member_id", "reviewed_at", "review_note") ON "attendance_events" TO ops_app;
    REVOKE DELETE, TRUNCATE ON "attendance_records", "attendance_adjustment_requests", "shifts",
      "employee_shift_assignments", "attendance_policies" FROM ops_app;
    GRANT EXECUTE ON FUNCTION "purge_attendance_coordinates"(uuid, integer) TO ops_app;
  END IF;
END;
$$;